const base = (process.env.PI_HARNESS_URL ?? "http://127.0.0.1:3141").replace(/\/$/u, "");
const response = await fetch(`${base}/api/state`);
if (!response.ok) throw new Error(`Pi Harness returned HTTP ${response.status}`);
console.log(JSON.stringify(await response.json(), null, 2));
