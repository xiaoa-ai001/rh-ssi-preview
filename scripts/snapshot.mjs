// Fetch GeckoTerminal board data from the Actions runner (one stable IP for
// everyone) and publish it same-origin as /data/boards.json. Browsers that are
// rate-limited or cannot reach GT directly (carrier CGNAT shares one 30/min
// quota across thousands of phones) fall back to this snapshot.
import { mkdir, writeFile } from 'node:fs/promises'

const BASE = 'https://api.geckoterminal.com/api/v2/networks/robinhood'
const ENDPOINTS = {
  trending_pools: `${BASE}/trending_pools?include=base_token`,
  pools: `${BASE}/pools?page=1&sort=h24_volume_usd_desc&include=base_token`,
  new_pools: `${BASE}/new_pools?page=1&include=base_token`,
}

const boards = {}
for (const [key, url] of Object.entries(ENDPOINTS)) {
  const r = await fetch(url, { headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error(`GT ${key} ${r.status}`)
  boards[key] = await r.json()
  await new Promise((resolve) => setTimeout(resolve, 1500)) // stay far under GT burst limits
}

await mkdir('data', { recursive: true })
await writeFile('data/boards.json', JSON.stringify({ at: Date.now(), boards }))
console.log('boards.json written:', Object.keys(boards).join(', '))
