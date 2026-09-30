# dev/
- `local-server.mjs` — runs `src/app.js` locally with a Map-backed cache and static files from `public/`. `PANTA_API_KEY=… node dev/local-server.mjs 8787`
- `shot.mjs` — QA screenshots with a local headless Chromium (needs `playwright-core`): `node dev/shot.mjs http://localhost:8787/ out.png 1440 900`
- `record.mjs` — scripted screen recordings of the live product for the demo video (needs `playwright-core`).
