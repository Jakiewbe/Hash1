import http from "node:http";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(ROOT, "miner.log");
const ERR_FILE = path.join(ROOT, "miner.err.log");
const HOST = "127.0.0.1";
const PORT = Number(process.env.DASHBOARD_PORT || 8787);
const MAX_READ = 1024 * 1024;

const samples = [];

function runPowerShell(command) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      { cwd: ROOT, windowsHide: true, timeout: 15000 },
      (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr, error }),
    );
  });
}

async function readTail(file, maxBytes = MAX_READ) {
  if (!existsSync(file)) return "";
  const info = await stat(file);
  const start = Math.max(0, info.size - maxBytes);
  const buffer = await readFile(file);
  return buffer.subarray(start).toString("utf8");
}

function normalizeLog(text) {
  return text
    .replace(/\r(?!\n)/g, "\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseHashrate(value) {
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  return 0;
}

function parseLog(lines) {
  const state = {
    miner: null,
    rpc: null,
    contract: null,
    genesisComplete: null,
    reward: null,
    difficulty: null,
    minted: null,
    remaining: null,
    epoch: null,
    epochBlocksLeft: null,
    balance: null,
    challenge: null,
    hashrate: 0,
    hashes: 0,
    foundNonce: null,
    result: null,
    tx: null,
    receipt: null,
    phase: "idle",
    lastLog: lines.slice(-80),
  };

  for (const line of lines) {
    let m;
    if ((m = line.match(/^contract\s+(.+)$/))) state.contract = m[1];
    else if ((m = line.match(/^miner\s+(.+)$/))) state.miner = m[1];
    else if ((m = line.match(/^rpc\s+(.+)$/))) state.rpc = m[1];
    else if ((m = line.match(/^genesis complete:\s+(\w+)/))) state.genesisComplete = m[1] === "true";
    else if ((m = line.match(/^era\s+(.+?)\s+\|\s+reward\s+(.+?)\s+\|\s+difficulty\s+(.+)$/))) {
      state.reward = m[2];
      state.difficulty = m[3];
    } else if ((m = line.match(/^minted\s+(.+?)\s+\|\s+remaining\s+(.+?)\s+\|\s+epoch\s+(.+?)\s+\|\s+(.+?)\s+blocks left$/))) {
      state.minted = m[1];
      state.remaining = m[2];
      state.epoch = m[3];
      state.epochBlocksLeft = m[4];
    } else if ((m = line.match(/^balance\s+(.+?)\s+\|\s+challenge\s+(.+)$/))) {
      state.balance = m[1];
      state.challenge = m[2];
    } else if ((m = line.match(/^searching\s+([0-9.]+)\s+H\/s\s+\|\s+([0-9,]+)\s+hashes$/))) {
      state.hashrate = parseHashrate(m[1]);
      state.hashes = Number(m[2].replaceAll(",", ""));
      state.phase = "searching";
    } else if ((m = line.match(/^found nonce\s+(.+)$/))) {
      state.foundNonce = m[1];
      state.phase = "found";
    } else if ((m = line.match(/^result\s+(.+)$/))) {
      state.result = m[1];
    } else if ((m = line.match(/^submitted\s+(.+)$/))) {
      state.tx = m[1];
      state.phase = "submitted";
    } else if ((m = line.match(/^receipt\s+(.+?)\s+in block\s+(.+)$/))) {
      state.receipt = { status: m[1], block: m[2] };
      state.phase = m[1] === "success" ? "accepted" : "reverted";
    } else if (line.includes("mining is not open yet")) {
      state.phase = "waiting";
    }
  }

  return state;
}

async function minerProcesses() {
  const command = `
Get-CimInstance Win32_Process -Filter "name = 'node.exe' OR name = 'cmd.exe'" |
  Where-Object { $_.CommandLine -like '*mine.mjs*' -or $_.CommandLine -like '*npm*run*mine*' } |
  Select-Object ProcessId,Name,CommandLine |
  ConvertTo-Json -Compress
`;
  const { stdout } = await runPowerShell(command);
  if (!stdout.trim()) return [];
  try {
    const data = JSON.parse(stdout);
    return Array.isArray(data) ? data : [data];
  } catch {
    return [];
  }
}

async function statusPayload() {
  const [logText, errText, procs] = await Promise.all([
    readTail(LOG_FILE),
    readTail(ERR_FILE, 64 * 1024),
    minerProcesses(),
  ]);
  const parsed = parseLog(normalizeLog(logText));
  parsed.running = procs.length > 0;
  parsed.processes = procs.map((p) => ({ id: p.ProcessId, name: p.Name }));
  parsed.errors = normalizeLog(errText).slice(-40);
  parsed.updatedAt = new Date().toISOString();

  if (parsed.hashrate > 0) {
    samples.push({ t: Date.now(), y: parsed.hashrate });
    while (samples.length > 180) samples.shift();
  }
  parsed.samples = samples;
  return parsed;
}

async function startMiner() {
  const command = `
$root = '${ROOT.replaceAll("'", "''")}'
$log = Join-Path $root 'miner.log'
$err = Join-Path $root 'miner.err.log'
Start-Process -FilePath 'npm.cmd' -ArgumentList @('run','mine') -WorkingDirectory $root -RedirectStandardOutput $log -RedirectStandardError $err -WindowStyle Hidden
`;
  return await runPowerShell(command);
}

async function stopMiner() {
  const command = `
Get-CimInstance Win32_Process -Filter "name = 'node.exe' OR name = 'cmd.exe'" |
  Where-Object { $_.CommandLine -like '*mine.mjs*' -or $_.CommandLine -like '*npm*run*mine*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
`;
  return await runPowerShell(command);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

const html = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HASH256 Miner Dashboard</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #070807;
      --panel: #0d100d;
      --panel-2: #111611;
      --line: rgba(133, 255, 168, .18);
      --line-strong: rgba(133, 255, 168, .38);
      --fg: #edf7ee;
      --muted: #8d9d90;
      --accent: #57ff8a;
      --amber: #ffd56d;
      --danger: #ff6b6b;
      --blue: #7eb6ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: radial-gradient(circle at 72% 6%, rgba(87,255,138,.1), transparent 30%), var(--bg);
      color: var(--fg);
      font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      letter-spacing: 0;
    }
    button { font: inherit; }
    .shell { min-height: 100svh; display: grid; grid-template-rows: auto 1fr; }
    header {
      height: 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      padding: 0 28px;
      border-bottom: 1px solid var(--line);
      background: rgba(7, 8, 7, .86);
      backdrop-filter: blur(12px);
      position: sticky;
      top: 0;
      z-index: 3;
    }
    .brand { display: flex; align-items: baseline; gap: 14px; min-width: 0; }
    h1 { margin: 0; color: var(--accent); font-size: 18px; letter-spacing: .08em; white-space: nowrap; }
    .sub { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .toolbar { display: flex; align-items: center; gap: 10px; }
    .btn {
      border: 1px solid var(--line-strong);
      color: var(--fg);
      background: transparent;
      padding: 8px 11px;
      cursor: pointer;
      transition: border-color .16s ease, color .16s ease, background .16s ease;
    }
    .btn:hover { border-color: var(--accent); color: var(--accent); background: rgba(87,255,138,.06); }
    .btn.danger:hover { border-color: var(--danger); color: var(--danger); background: rgba(255,107,107,.06); }
    main {
      width: min(1440px, 100%);
      margin: 0 auto;
      padding: 26px 28px 34px;
      display: grid;
      gap: 22px;
    }
    .status {
      display: grid;
      grid-template-columns: minmax(260px, 1fr) minmax(300px, 1.35fr);
      gap: 22px;
      align-items: stretch;
    }
    .hero, .chart, .log, .facts {
      border: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(17,22,17,.86), rgba(9,12,9,.94));
    }
    .hero { padding: 26px; display: grid; gap: 26px; align-content: space-between; }
    .state { display: flex; align-items: center; gap: 12px; color: var(--muted); text-transform: uppercase; font-size: 12px; letter-spacing: .12em; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--danger); box-shadow: 0 0 0 6px rgba(255,107,107,.08); }
    .running .dot { background: var(--accent); box-shadow: 0 0 18px rgba(87,255,138,.56), 0 0 0 6px rgba(87,255,138,.08); }
    .metric { display: grid; gap: 4px; }
    .metric .value { font-size: clamp(38px, 7vw, 88px); line-height: .9; color: var(--accent); font-weight: 700; }
    .metric .label { color: var(--muted); text-transform: uppercase; letter-spacing: .12em; font-size: 12px; }
    .minor { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
    .kv { min-width: 0; border-top: 1px solid var(--line); padding-top: 12px; }
    .kv span { display: block; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .12em; }
    .kv strong { display: block; margin-top: 5px; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .chart { min-height: 360px; padding: 18px; display: grid; grid-template-rows: auto 1fr; }
    .section-title { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .12em; margin-bottom: 12px; }
    canvas { width: 100%; height: 100%; min-height: 280px; display: block; }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr);
      gap: 22px;
    }
    .facts { padding: 20px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 22px; align-content: start; }
    .log { padding: 18px; min-height: 360px; }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      color: #c7d9ca;
      max-height: 420px;
      overflow: auto;
      scrollbar-color: var(--line-strong) transparent;
    }
    .ok { color: var(--accent); }
    .warn { color: var(--amber); }
    .bad { color: var(--danger); }
    .blue { color: var(--blue); }
    .fade-in { animation: rise .42s ease both; }
    @keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @media (max-width: 900px) {
      header { height: auto; padding: 16px; align-items: flex-start; flex-direction: column; }
      main { padding: 16px; }
      .status, .grid { grid-template-columns: 1fr; }
      .facts { grid-template-columns: 1fr; }
      .toolbar { flex-wrap: wrap; }
      .minor { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="brand">
        <h1>$HASH MINER</h1>
        <div class="sub" id="address">loading local miner state</div>
      </div>
      <div class="toolbar">
        <button class="btn" id="refresh">Refresh</button>
        <button class="btn" id="start">Start</button>
        <button class="btn danger" id="stop">Stop</button>
      </div>
    </header>
    <main>
      <section class="status fade-in" id="status">
        <div class="hero" id="hero">
          <div class="state"><span class="dot"></span><span id="runState">unknown</span></div>
          <div class="metric">
            <div class="value" id="hashrate">0</div>
            <div class="label">hashes per second</div>
          </div>
          <div class="minor">
            <div class="kv"><span>searched</span><strong id="hashes">0</strong></div>
            <div class="kv"><span>phase</span><strong id="phase">idle</strong></div>
          </div>
        </div>
        <div class="chart">
          <div class="section-title"><span>hashrate trace</span><span id="updated">--</span></div>
          <canvas id="chart" width="1000" height="360"></canvas>
        </div>
      </section>
      <section class="grid fade-in">
        <div class="facts">
          <div class="kv"><span>balance</span><strong id="balance">--</strong></div>
          <div class="kv"><span>reward</span><strong id="reward">--</strong></div>
          <div class="kv"><span>minted</span><strong id="minted">--</strong></div>
          <div class="kv"><span>remaining</span><strong id="remaining">--</strong></div>
          <div class="kv"><span>difficulty</span><strong id="difficulty">--</strong></div>
          <div class="kv"><span>challenge</span><strong id="challenge">--</strong></div>
          <div class="kv"><span>last tx</span><strong id="tx">--</strong></div>
          <div class="kv"><span>receipt</span><strong id="receipt">--</strong></div>
        </div>
        <div class="log">
          <div class="section-title"><span>latest log</span><span id="processes">--</span></div>
          <pre id="log"></pre>
        </div>
      </section>
    </main>
  </div>
  <script>
    const $ = (id) => document.getElementById(id);
    const fmt = new Intl.NumberFormat("en-US");
    const fmtRate = (n) => {
      if (!Number.isFinite(n) || n <= 0) return "0";
      if (n >= 1e9) return (n / 1e9).toFixed(2) + "G";
      if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
      return n.toFixed(0);
    };
    function colorPhase(phase) {
      if (phase === "accepted") return "ok";
      if (phase === "submitted" || phase === "found") return "blue";
      if (phase === "waiting") return "warn";
      if (phase === "reverted") return "bad";
      return "";
    }
    function draw(samples) {
      const canvas = $("chart");
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      const ctx = canvas.getContext("2d");
      ctx.scale(dpr, dpr);
      const w = rect.width, h = rect.height;
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = "rgba(133,255,168,.12)";
      ctx.lineWidth = 1;
      for (let i = 0; i < 5; i++) {
        const y = 20 + i * ((h - 40) / 4);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }
      if (!samples || samples.length < 2) return;
      const maxY = Math.max(...samples.map(s => s.y), 1);
      const minT = samples[0].t;
      const maxT = samples[samples.length - 1].t || minT + 1;
      ctx.strokeStyle = "#57ff8a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      samples.forEach((s, i) => {
        const x = ((s.t - minT) / Math.max(1, maxT - minT)) * (w - 20) + 10;
        const y = h - 20 - (s.y / maxY) * (h - 46);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.fillStyle = "rgba(87,255,138,.08)";
      ctx.lineTo(w - 10, h - 20); ctx.lineTo(10, h - 20); ctx.closePath(); ctx.fill();
    }
    async function refresh() {
      const res = await fetch("/api/status", { cache: "no-store" });
      const s = await res.json();
      $("hero").classList.toggle("running", !!s.running);
      $("runState").textContent = s.running ? "running" : "stopped";
      $("address").textContent = s.miner || "wallet unavailable";
      $("hashrate").textContent = fmtRate(s.hashrate);
      $("hashes").textContent = fmt.format(s.hashes || 0);
      $("phase").textContent = s.phase || "idle";
      $("phase").className = colorPhase(s.phase);
      $("balance").textContent = s.balance || "--";
      $("reward").textContent = s.reward || "--";
      $("minted").textContent = s.minted || "--";
      $("remaining").textContent = s.remaining || "--";
      $("difficulty").textContent = s.difficulty || "--";
      $("challenge").textContent = s.challenge || "--";
      $("tx").innerHTML = s.tx ? '<a class="blue" href="https://etherscan.io/tx/' + s.tx + '" target="_blank" rel="noreferrer">' + s.tx.slice(0, 10) + "..." + s.tx.slice(-6) + "</a>" : "--";
      $("receipt").textContent = s.receipt ? s.receipt.status + " @ " + s.receipt.block : "--";
      $("processes").textContent = (s.processes || []).length + " process(es)";
      $("updated").textContent = new Date(s.updatedAt).toLocaleTimeString();
      $("log").textContent = (s.lastLog || []).join("\n");
      draw(s.samples || []);
    }
    async function action(name) {
      await fetch("/api/" + name, { method: "POST" });
      setTimeout(refresh, 1200);
    }
    $("refresh").onclick = refresh;
    $("start").onclick = () => action("start");
    $("stop").onclick = () => confirm("Stop the miner process?") && action("stop");
    window.addEventListener("resize", () => refresh());
    refresh();
    setInterval(refresh, 1500);
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      sendJson(res, 200, await statusPayload());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/start") {
      const procs = await minerProcesses();
      if (procs.length === 0) await startMiner();
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/stop") {
      await stopMiner();
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`HASH256 dashboard: http://${HOST}:${PORT}`);
});
