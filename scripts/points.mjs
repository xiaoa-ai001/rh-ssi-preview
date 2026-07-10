// Compute the SSI points snapshot from on-chain-verifiable data and publish it
// same-origin as /data/points.json (read by the Points page).
//
// Scoring (documented on the Points page — keep the two in sync):
//   - 1 USD of trade volume on any ssi.fun-launched pool = 1 point
//   - referral bonus: 10% of each invitee's base points goes to their referrer
//     (bindings come from the on-chain ReferralRegistry, event Bound)
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const GT = 'https://api.geckoterminal.com/api/v2/networks/robinhood'
const RPC = 'https://rpc.mainnet.chain.robinhood.com'
const REFERRAL_REGISTRY = '0xe616b60bDD1E3aC0719eE2b81d2d0bd7018A957D'
const REGISTRY_DEPLOY_BLOCK = 6147237
// keccak256("Bound(address,address)")
const BOUND_TOPIC = '0x0d128562eaa47ab89086803e64a0f96847c0ed3cc63c26251f29ba1aede09d4e'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function gt(path) {
  const r = await fetch(`${GT}${path}`, { headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error(`GT ${path} ${r.status}`)
  await sleep(1500) // stay far under GT burst limits
  return r.json()
}

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const j = await r.json()
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message}`)
  return j.result
}

// ---- 1) our launched tokens (tokenlist.json, minus WETH) ----
const tokenlist = JSON.parse(await readFile('tokenlist.json', 'utf8'))
const tokens = tokenlist.tokens
  .map((t) => t.address.toLowerCase())
  .filter((a) => a !== '0x0bd7d308f8e1639fab988df18a8011f41eacad73') // WETH is the numeraire, not ours

// ---- 2) per-wallet volume across each token's pools ----
const wallets = new Map() // addr -> { volumeUsd, trades }
const bump = (addr, usd) => {
  const k = addr.toLowerCase()
  const w = wallets.get(k) ?? { volumeUsd: 0, trades: 0 }
  w.volumeUsd += usd
  w.trades += 1
  wallets.set(k, w)
}

for (const token of tokens) {
  let pools = []
  try {
    const res = await gt(`/tokens/${token}/pools`)
    pools = (res.data ?? []).map((p) => p.attributes.address)
  } catch (e) {
    console.error(`pools lookup failed for ${token}: ${e.message}`)
    continue
  }
  for (const pool of pools.slice(0, 3)) {
    try {
      const res = await gt(`/pools/${pool}/trades`)
      for (const t of res.data ?? []) {
        const a = t.attributes
        const usd = Number(a.volume_in_usd ?? 0)
        if (a.tx_from_address && usd > 0) bump(a.tx_from_address, usd)
      }
    } catch (e) {
      console.error(`trades failed for pool ${pool}: ${e.message}`)
    }
  }
}

// ---- 3) referral bindings from the on-chain registry ----
const referrerOf = new Map() // invitee -> referrer
const referrals = new Map() // referrer -> count
try {
  const logs = await rpc('eth_getLogs', [
    {
      address: REFERRAL_REGISTRY,
      topics: [BOUND_TOPIC],
      fromBlock: '0x' + REGISTRY_DEPLOY_BLOCK.toString(16),
      toBlock: 'latest',
    },
  ])
  for (const log of logs) {
    const invitee = '0x' + log.topics[1].slice(26)
    const referrer = '0x' + log.topics[2].slice(26)
    referrerOf.set(invitee.toLowerCase(), referrer.toLowerCase())
    referrals.set(referrer.toLowerCase(), (referrals.get(referrer.toLowerCase()) ?? 0) + 1)
  }
} catch (e) {
  console.error(`referral logs failed (non-fatal): ${e.message}`)
}

// ---- 4) score: base = volume, then 10% of invitee base points to the referrer ----
const points = new Map() // addr -> points
for (const [addr, w] of wallets) points.set(addr, w.volumeUsd)
for (const [invitee, referrer] of referrerOf) {
  const base = wallets.get(invitee)?.volumeUsd ?? 0
  if (base > 0) points.set(referrer, (points.get(referrer) ?? 0) + base * 0.1)
}

const out = {
  updated: new Date().toISOString(),
  wallets: [...points.entries()]
    .map(([address, pts]) => ({
      address,
      points: Math.round(pts),
      volumeUsd: Math.round((wallets.get(address)?.volumeUsd ?? 0) * 100) / 100,
      trades: wallets.get(address)?.trades ?? 0,
      referrals: referrals.get(address) ?? 0,
    }))
    .sort((a, b) => b.points - a.points)
    .slice(0, 200),
}

await mkdir('data', { recursive: true })
await writeFile('data/points.json', JSON.stringify(out))
console.log(`points.json written: ${out.wallets.length} wallets, ${referrerOf.size} referral bindings`)
