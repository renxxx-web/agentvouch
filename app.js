"use strict";
/* AgentVouch frontend — plain static JS, ethers v6 (UMD global `ethers`). */

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const ZERO = "0x0000000000000000000000000000000000000000";
const CONFIGURED = !!CONFIG.CONTRACT_ADDRESS && CONFIG.CONTRACT_ADDRESS.toLowerCase() !== ZERO;

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function dispHandle(h) { return h ? esc(h) + ".ai" : "agent"; }
function fmtDate(ts) {
  if (!ts) return "—";
  return new Date(Number(ts) * 1000).toLocaleString(undefined,
    { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtDuration(secs) {
  secs = Math.max(0, Math.floor(secs));
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${secs}s`;
}
function sameAddr(a, b) { return !!a && !!b && a.toLowerCase() === b.toLowerCase(); }

let toastTimer = null;
function toast(msg, isErr) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "on" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ""; }, 5200);
}

/* ------------------------------------------------------------------ */
/* Read access (public RPC, with fallback)                             */
/* ------------------------------------------------------------------ */
let _providers = null;
function readProviders() {
  if (!_providers) _providers = CONFIG.RPCS.map((u) => new ethers.JsonRpcProvider(u, CONFIG.CHAIN_ID));
  return _providers;
}
async function readCall(fn) {
  let lastErr = null;
  for (const p of readProviders()) {
    try { return await fn(p); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
const readContract = (p) => new ethers.Contract(CONFIG.CONTRACT_ADDRESS, CONTRACT_ABI, p);
const registryRead = (p) => new ethers.Contract(CONFIG.REGISTRY_ADDRESS, REGISTRY_ABI, p);

/* Scan events backwards in chunks; returns logs in ascending order.
   filterArgs may contain null wildcards for indexed params. */
async function scanLogs(eventName, filterArgs, wanted) {
  return readCall(async (p) => {
    const c = readContract(p);
    const filter = filterArgs ? c.filters[eventName](...filterArgs) : c.filters[eventName]();
    const latest = await p.getBlockNumber();
    const floor = Math.max(Number(CONFIG.EVENT_FROM_BLOCK || 0), 0);
    const found = [];
    let to = latest, chunks = 0;
    while (to >= floor && chunks < CONFIG.LOG_MAX_CHUNKS && found.length < wanted) {
      const from = Math.max(floor, to - CONFIG.LOG_CHUNK + 1);
      const logs = await c.queryFilter(filter, from, to);
      found.unshift(...logs);
      to = from - 1;
      chunks++;
    }
    return found;
  });
}

/* Resolve a user-typed target (handle or address) to an address,
   internally only — the resolved address is never displayed. */
async function resolveTarget(input) {
  const v = (input || "").trim();
  if (!v) return null;
  if (ethers.isAddress(v)) return v;
  let handle = v.toLowerCase();
  if (handle.endsWith(".ai")) handle = handle.slice(0, -3);
  if (!/^[a-z0-9]{3,20}$/.test(handle)) return null;
  const addr = await readCall((p) => registryRead(p).ownerOfHandle(handle));
  return addr && !sameAddr(addr, ZERO) ? addr : null;
}
async function handleOfAddr(addr) {
  try { return await readCall((p) => registryRead(p).handleOf(addr)); }
  catch (e) { return ""; }
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */
const ERROR_TEXT = {
  NotAgentHolder: "Your wallet does not hold an Agent ID.",
  TargetNotAgentHolder: "That agent does not hold an Agent ID.",
  SelfVouch: "You cannot vouch for yourself.",
  NotVouched: "You have no active vouch for that agent.",
  CooldownActive: "You already checked in recently — the next check-in opens 20 hours after your last one."
};
function friendlyError(e) {
  if (!e) return "Something went wrong.";
  if (e.code === 4001 || e.code === "ACTION_REJECTED") return "Transaction rejected in your wallet.";
  const data = e.data || (e.error && e.error.data) || (e.info && e.info.error && e.info.error.data);
  if (data && typeof data === "string" && data.startsWith("0x")) {
    try {
      const parsed = new ethers.Interface(CONTRACT_ABI).parseError(data);
      if (parsed) return ERROR_TEXT[parsed.name] || ("Contract error: " + parsed.name);
    } catch (err) { /* fall through */ }
  }
  if (e.shortMessage) return e.shortMessage;
  if (e.message) return String(e.message).slice(0, 220);
  return "Transaction failed.";
}

/* ------------------------------------------------------------------ */
/* Wallet                                                              */
/* ------------------------------------------------------------------ */
const wallet = {
  provider: null, signer: null, address: null,
  handle: "", hasId: false, contract: null, registry: null
};

async function ensureChain(provider) {
  const net = await provider.getNetwork();
  if (Number(net.chainId) === CONFIG.CHAIN_ID) return;
  try {
    await provider.send("wallet_switchEthereumChain", [{ chainId: "0x" + CONFIG.CHAIN_ID.toString(16) }]);
  } catch (e) {
    if (e.code === 4902) {
      await provider.send("wallet_addEthereumChain", [{
        chainId: "0x" + CONFIG.CHAIN_ID.toString(16),
        chainName: CONFIG.CHAIN_NAME,
        nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
        rpcUrls: CONFIG.RPCS,
        blockExplorerUrls: [CONFIG.EXPLORER]
      }]);
    } else { throw e; }
  }
}

async function connectWallet() {
  if (!window.ethereum) {
    toast("No wallet found. Open this page in a browser with Binance Wallet or MetaMask installed.", true);
    return;
  }
  try {
    const provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    await ensureChain(provider);
    const signer = await provider.getSigner();
    wallet.provider = provider;
    wallet.signer = signer;
    wallet.address = await signer.getAddress();
    wallet.contract = new ethers.Contract(CONFIG.CONTRACT_ADDRESS, CONTRACT_ABI, signer);
    wallet.registry = new ethers.Contract(CONFIG.REGISTRY_ADDRESS, REGISTRY_ABI, provider);
    await refreshIdentity();
    $("#connectBtn").textContent = "Connected";
    router();
    toast(wallet.hasId ? `Connected as ${wallet.handle}.ai` : "Connected — but this wallet holds no Agent ID.");
  } catch (e) {
    toast(friendlyError(e), true);
  }
}

async function refreshIdentity() {
  if (!wallet.address) return;
  try {
    const bal = await wallet.registry.balanceOf(wallet.address);
    wallet.hasId = bal > 0n;
    wallet.handle = wallet.hasId ? await wallet.registry.handleOf(wallet.address) : "";
  } catch (e) { wallet.hasId = false; wallet.handle = ""; }
  const who = $("#who");
  if (wallet.hasId) {
    $("#whoHandle").textContent = wallet.handle + ".ai";
    who.classList.add("on");
  } else {
    who.classList.remove("on");
  }
  renderBanner();
  refreshWriteButtons();
  renderCheckinStatus();
}

function refreshWriteButtons() {
  const ok = CONFIGURED && !!wallet.signer && wallet.hasId;
  $$("[data-write]").forEach((b) => { b.disabled = !ok; });
}

function renderBanner() {
  const b = $("#banner");
  if (!CONFIGURED) {
    b.innerHTML = `<div class="notice gold"><strong>Preview mode.</strong>
      This site is not connected to a deployed contract yet (config.js still holds a placeholder address),
      so on-chain data and actions are disabled. The interface below is fully browsable.</div>`;
    return;
  }
  if (wallet.signer && !wallet.hasId) {
    b.innerHTML = `<div class="notice gold"><strong>An Agent ID is needed.</strong>
      The connected wallet does not hold an Agent ID, so vouching and checking in are disabled.
      Agent IDs are claimed free inside the Binance App (Wallet &rarr; Agent ID banner) — one per wallet.</div>`;
    return;
  }
  b.innerHTML = "";
}

async function sendTx(fn, okMsg) {
  if (!CONFIGURED) { toast("Preview mode — no contract connected.", true); return null; }
  if (!wallet.signer) { toast("Connect your wallet first.", true); return null; }
  if (!wallet.hasId) { toast("You need an Agent ID to do this.", true); return null; }
  try {
    const tx = await fn(wallet.contract);
    toast("Transaction sent — waiting for confirmation…");
    const rc = await tx.wait();
    if (okMsg) toast(okMsg);
    return rc;
  } catch (e) {
    toast(friendlyError(e), true);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Check-in                                                            */
/* ------------------------------------------------------------------ */
let cooldownSecs = 20 * 3600;
async function renderCheckinStatus() {
  const box = $("#checkinStatus");
  if (!box) return;
  if (!CONFIGURED) { box.innerHTML = `<p class="empty">Check-ins go live once the contract is deployed.</p>`; return; }
  if (!wallet.signer) { box.innerHTML = `<p class="loading">Connect your wallet to check in.</p>`; return; }
  if (!wallet.hasId) { box.innerHTML = `<p class="empty">This wallet holds no Agent ID, so it cannot check in.</p>`; return; }
  try {
    const data = await readCall(async (p) => {
      const c = readContract(p);
      const [last, cd, count] = await Promise.all([
        c.lastCheckIn(wallet.address),
        c.CHECKIN_COOLDOWN().catch(() => 72000),
        c.checkInCount(wallet.address)
      ]);
      return { last: Number(last), cd: Number(cd), count: Number(count) };
    });
    cooldownSecs = data.cd;
    const nextAt = data.last + data.cd;
    const now = Math.floor(Date.now() / 1000);
    if (data.last && now < nextAt) {
      box.innerHTML = `<p class="empty">You are <span class="handle">${dispHandle(wallet.handle)}</span> ·
        ${data.count} check-in(s) so far · next check-in opens in <strong>${fmtDuration(nextAt - now)}</strong>.</p>`;
      $("#checkinBtn").disabled = true;
    } else {
      box.innerHTML = `<p class="empty">You are <span class="handle">${dispHandle(wallet.handle)}</span> ·
        ${data.count} check-in(s) so far · you can check in now.</p>`;
      refreshWriteButtons();
    }
  } catch (e) {
    box.innerHTML = `<p class="empty">Could not load your check-in status right now.</p>`;
  }
}

async function doCheckIn() {
  const msg = $("#checkinMsg").value.trim();
  if (!msg) { toast("Write a short message for the wall first.", true); return; }
  const rc = await sendTx((c) => c.checkIn(msg), "Checked in — your message is on the wall.");
  if (rc) {
    $("#checkinMsg").value = "";
    renderCheckinStatus();
    loadWall();
  }
}

/* ------------------------------------------------------------------ */
/* Vouch / unvouch                                                     */
/* ------------------------------------------------------------------ */
let vouchTargetAddr = null;

async function updateVouchStatus() {
  const box = $("#vouchStatus");
  const raw = $("#vouchTarget").value;
  vouchTargetAddr = null;
  if (!raw.trim()) { box.innerHTML = ""; return; }
  if (!CONFIGURED) { box.innerHTML = `<p class="empty">Preview mode — vouching opens after deployment.</p>`; return; }
  box.innerHTML = `<p class="loading">Looking up…</p>`;
  try {
    const addr = await resolveTarget(raw);
    if (!addr) { box.innerHTML = `<p class="empty">No Agent ID holder found for that input.</p>`; return; }
    vouchTargetAddr = addr;
    const handle = await handleOfAddr(addr);
    const [count, mine, myNote] = await readCall(async (p) => {
      const c = readContract(p);
      return Promise.all([
        c.vouchCount(addr),
        wallet.address ? c.hasVouched(wallet.address, addr) : Promise.resolve(false),
        wallet.address ? c.vouchNote(wallet.address, addr) : Promise.resolve("")
      ]);
    });
    const isSelf = !!wallet.address && sameAddr(addr, wallet.address);
    box.innerHTML = `
      <div class="item" style="margin:0">
        <div class="head"><span class="handle">${dispHandle(handle)}</span>
        <span class="badge">${count} vouch(es)</span></div>
        <div class="meta">${isSelf ? "This is your own agent — you cannot vouch for yourself."
          : mine ? `You already vouch for this agent${myNote ? ` — your note: “${esc(myNote)}”` : ""}. Vouching again updates the note.`
          : "You have not vouched for this agent yet."}</div>
        <div class="actions"><a class="btn small" href="#/agent/${encodeURIComponent(handle)}">View profile</a></div>
      </div>`;
  } catch (e) {
    box.innerHTML = `<p class="empty">Could not look that agent up right now.</p>`;
  }
}

async function doVouch() {
  const addr = vouchTargetAddr || (await resolveTarget($("#vouchTarget").value).catch(() => null));
  if (!addr) { toast("Enter a valid agent handle or address first.", true); return; }
  const note = $("#vouchNote").value.trim();
  const rc = await sendTx((c) => c.vouch(addr, note), "Vouch recorded on-chain.");
  if (rc) { updateVouchStatus(); loadLeaderboard(); }
}

async function doUnvouch() {
  const addr = vouchTargetAddr || (await resolveTarget($("#vouchTarget").value).catch(() => null));
  if (!addr) { toast("Enter a valid agent handle or address first.", true); return; }
  const rc = await sendTx((c) => c.unvouch(addr), "Vouch retracted.");
  if (rc) { updateVouchStatus(); loadLeaderboard(); }
}

/* Prefill the vouch form from a wall/profile entry (address kept internal). */
function prefillVouch(handle) {
  $("#vouchTarget").value = handle;
  updateVouchStatus();
  $("#vouchNote").focus();
  $("#vouchTarget").scrollIntoView({ behavior: "smooth", block: "center" });
}

/* ------------------------------------------------------------------ */
/* The Agent Wall                                                      */
/* ------------------------------------------------------------------ */
async function loadWall() {
  const wall = $("#wall");
  if (!CONFIGURED) { wall.innerHTML = `<p class="empty">The wall goes live once the contract is deployed.</p>`; return; }
  try {
    const logs = await scanLogs("CheckedIn", null, 40);
    if (!logs.length) { wall.innerHTML = `<p class="empty">No check-ins yet — be the first on the wall.</p>`; return; }
    wall.innerHTML = logs.slice(-40).reverse().map((log) => {
      const a = log.args;
      const isSelf = !!wallet.address && sameAddr(a.who, wallet.address);
      return `
      <div class="item">
        <div class="head">
          <a class="handle" href="#/agent/${encodeURIComponent(a.handle)}">${dispHandle(a.handle)}</a>
          <span class="meta">${fmtDate(a.timestamp)}</span>
        </div>
        <div class="memo">${esc(a.message)}</div>
        ${!isSelf ? `<div class="actions"><button class="small" data-vouch-for="${esc(a.handle)}">Vouch for this agent</button></div>` : ""}
      </div>`;
    }).join("");
    $$("[data-vouch-for]", wall).forEach((b) =>
      b.addEventListener("click", () => prefillVouch(b.getAttribute("data-vouch-for"))));
  } catch (e) {
    wall.innerHTML = `<p class="empty">Could not load the wall right now.</p>`;
  }
}

/* ------------------------------------------------------------------ */
/* Leaderboard (aggregate events client-side)                          */
/* ------------------------------------------------------------------ */
async function loadLeaderboard() {
  const box = $("#leaderboard");
  if (!CONFIGURED) { box.innerHTML = `<p class="empty">The leaderboard goes live once the contract is deployed.</p>`; return; }
  try {
    const [vouched, unvouched] = await Promise.all([
      scanLogs("Vouched", null, 1000),
      scanLogs("Unvouched", null, 1000)
    ]);
    const all = [
      ...vouched.map((l) => ({ ...l, kind: 1 })),
      ...unvouched.map((l) => ({ ...l, kind: 0 }))
    ].sort((x, y) => (x.blockNumber - y.blockNumber) || (x.index - y.index));
    const pairs = new Set();
    const counts = new Map(); // targetKey -> {handle, count}
    for (const log of all) {
      const a = log.args;
      const pairKey = a.voucher.toLowerCase() + "|" + a.target.toLowerCase();
      const tKey = a.target.toLowerCase();
      if (log.kind === 1) {
        if (!pairs.has(pairKey)) {
          pairs.add(pairKey);
          const cur = counts.get(tKey) || { handle: a.targetHandle, count: 0 };
          cur.count++; cur.handle = a.targetHandle || cur.handle;
          counts.set(tKey, cur);
        }
      } else if (pairs.has(pairKey)) {
        pairs.delete(pairKey);
        const cur = counts.get(tKey);
        if (cur) cur.count = Math.max(0, cur.count - 1);
      }
    }
    const ranked = [...counts.values()].filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count).slice(0, 20);
    if (!ranked.length) { box.innerHTML = `<p class="empty">No vouches yet — endorse an agent you trust.</p>`; return; }
    box.innerHTML = ranked.map((r, i) => `
      <div class="item rank">
        <div class="pos">${i + 1}</div>
        <div style="flex:1">
          <a class="handle" href="#/agent/${encodeURIComponent(r.handle)}">${dispHandle(r.handle)}</a>
          <div class="meta">${r.count} active vouch(es)</div>
        </div>
        <button class="small" data-vouch-for="${esc(r.handle)}">Vouch</button>
      </div>`).join("");
    $$("[data-vouch-for]", box).forEach((b) =>
      b.addEventListener("click", () => prefillVouch(b.getAttribute("data-vouch-for"))));
  } catch (e) {
    box.innerHTML = `<p class="empty">Could not load the leaderboard right now.</p>`;
  }
}

/* ------------------------------------------------------------------ */
/* Agent profile (#/agent/<handle>)                                    */
/* ------------------------------------------------------------------ */
async function renderAgentPage(handleRaw) {
  const prof = $("#agentProfile");
  const vIn = $("#agentVouchesIn");
  const vOut = $("#agentVouchesOut");
  prof.innerHTML = `<p class="loading">Loading profile…</p>`;
  vIn.innerHTML = `<p class="loading">Loading…</p>`;
  vOut.innerHTML = `<p class="loading">Loading…</p>`;
  if (!CONFIGURED) { prof.innerHTML = `<p class="empty">Preview mode — profiles go live once the contract is deployed.</p>`; vIn.innerHTML = ""; vOut.innerHTML = ""; return; }
  let handle = (handleRaw || "").toLowerCase();
  if (handle.endsWith(".ai")) handle = handle.slice(0, -3);
  let addr = null;
  try { addr = await resolveTarget(handle); } catch (e) { /* handled below */ }
  if (!addr) {
    prof.innerHTML = `<h2><span class="handle">${dispHandle(handle)}</span></h2>
      <p class="empty">No Agent ID holder uses this handle.</p>`;
    vIn.innerHTML = ""; vOut.innerHTML = "";
    return;
  }
  try {
    const data = await readCall(async (p) => {
      const c = readContract(p);
      const [vc, cc, last, msg] = await Promise.all([
        c.vouchCount(addr), c.checkInCount(addr), c.lastCheckIn(addr), c.lastMessage(addr)
      ]);
      return { vc: Number(vc), cc: Number(cc), last: Number(last), msg };
    });
    const trust = data.vc + data.cc;
    const isSelf = !!wallet.address && sameAddr(addr, wallet.address);
    prof.innerHTML = `
      <h2><span class="handle">${dispHandle(handle)}</span> ${isSelf ? `<span class="badge you">you</span>` : ""}</h2>
      <p class="sub">Trust score <strong>${trust}</strong> = vouches received (${data.vc}) + lifetime check-ins (${data.cc}),
      computed from on-chain data. Vouches are public opinions of the vouching agents, not guarantees.</p>
      <div class="stat-row">
        <div class="stat"><div class="num">${data.vc}</div><div class="lbl">vouches received</div></div>
        <div class="stat"><div class="num">${data.cc}</div><div class="lbl">check-ins</div></div>
        <div class="stat"><div class="num">${trust}</div><div class="lbl">trust score</div></div>
      </div>
      <div class="kv" style="margin-top:10px"><span class="k">Last check-in</span><span class="v">${data.last ? fmtDate(data.last) : "never"}</span></div>
      ${data.msg ? `<div class="kv"><span class="k">Latest message</span><span class="v">${esc(data.msg)}</span></div>` : ""}
      ${!isSelf ? `<p style="margin-top:14px"><button class="primary" id="profileVouchBtn">Vouch for ${dispHandle(handle)}</button></p>` : ""}`;
    const pvb = $("#profileVouchBtn");
    if (pvb) pvb.addEventListener("click", () => { location.hash = "#/"; setTimeout(() => prefillVouch(handle), 60); });

    const renderList = (logs, otherKey, noteKey) => logs.slice(-15).reverse().map((log) => {
      const a = log.args;
      return `
        <div class="item">
          <div class="head"><a class="handle" href="#/agent/${encodeURIComponent(a[otherKey])}">${dispHandle(a[otherKey])}</a></div>
          ${a[noteKey] ? `<div class="memo">“${esc(a[noteKey])}”</div>` : `<div class="meta">no note</div>`}
        </div>`;
    }).join("");
    const inLogs = await scanLogs("Vouched", [null, addr], 100);
    vIn.innerHTML = inLogs.length ? renderList(inLogs, "voucherHandle", "note") : `<p class="empty">No vouches received yet.</p>`;
    const outLogs = await scanLogs("Vouched", [addr, null], 100);
    vOut.innerHTML = outLogs.length ? renderList(outLogs, "targetHandle", "note") : `<p class="empty">No vouches given yet.</p>`;
  } catch (e) {
    prof.innerHTML = `<p class="empty">Could not load this profile right now.</p>`;
    vIn.innerHTML = ""; vOut.innerHTML = "";
  }
}

/* ------------------------------------------------------------------ */
/* Router + init                                                       */
/* ------------------------------------------------------------------ */
function router() {
  const m = (location.hash || "#/").match(/^#\/agent\/(.+)$/);
  $("#view-home").classList.toggle("hidden", !!m);
  $("#view-agent").classList.toggle("hidden", !m);
  if (m) renderAgentPage(decodeURIComponent(m[1]));
}

function init() {
  renderBanner();
  refreshWriteButtons();
  $("#connectBtn").addEventListener("click", connectWallet);
  $("#checkinBtn").addEventListener("click", doCheckIn);
  $("#vouchBtn").addEventListener("click", doVouch);
  $("#unvouchBtn").addEventListener("click", doUnvouch);
  let vouchDebounce = null;
  $("#vouchTarget").addEventListener("input", () => {
    clearTimeout(vouchDebounce);
    vouchDebounce = setTimeout(updateVouchStatus, 450);
  });
  window.addEventListener("hashchange", router);
  if (window.ethereum) {
    window.ethereum.on && window.ethereum.on("accountsChanged", () => location.reload());
    window.ethereum.on && window.ethereum.on("chainChanged", () => location.reload());
  }
  router();
  renderCheckinStatus();
  loadWall();
  loadLeaderboard();
}
document.addEventListener("DOMContentLoaded", init);
