import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import _ from "lodash";

// ── Config ───────────────────────────────────────────────────────────
const STORE_KEY = "instaclean-v1";
const API_DELAY_MIN = 4000;
const API_DELAY_MAX = 7000;
const SCAN_BATCH_SIZE = 50;

const TABS = [
  { id: "changes", label: "Changes", icon: "🔀", color: "#3B82F6" },
  { id: "unfollowers", label: "Don't follow back", icon: "💔", color: "#EF4444" },
  { id: "fans", label: "You don't follow", icon: "👻", color: "#F59E0B" },
  { id: "mutuals", label: "Mutuals", icon: "🤝", color: "#10B981" },
  { id: "whitelist", label: "Whitelist", icon: "🤍", color: "#A78BFA" },
];

// ── Script builders ──────────────────────────────────────────────────
function buildScanScript() {
  return [
    "// InstaClean — Instagram Data Export Script",
    "// Paste this in your browser console while logged into instagram.com",
    "",
    "(async () => {",
    '  const match = document.cookie.match(/ds_user_id=(\\d+)/);',
    '  if (!match) return alert("Log into Instagram first.");',
    "  const userId = match[1];",
    '  const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1];',
    "  const wait = ms => new Promise(r => setTimeout(r, ms));",
    "",
    "  async function fetchList(type) {",
    '    const isFollowers = type === "followers";',
    "    const hash = isFollowers",
    '      ? "c76146de99bb02f6415203be841dd25a"',
    '      : "d04b0a864b4b54837c0d870b0e77e076";',
    '    const key = isFollowers ? "edge_followed_by" : "edge_follow";',
    "    const users = [];",
    "    let cursor = null;",
    "    let hasNext = true;",
    "    while (hasNext) {",
    "      const vars = JSON.stringify({",
    "        id: userId, include_reel: false,",
    "        fetch_mutual: false, first: 50,",
    "        ...(cursor ? { after: cursor } : {})",
    "      });",
    '      const url = "https://www.instagram.com/graphql/query/"',
    '        + "?query_hash=" + hash',
    '        + "&variables=" + encodeURIComponent(vars);',
    "      const res = await fetch(url, {",
    '        headers: { "x-csrftoken": csrf }',
    "      });",
    "      if (!res.ok) { await wait(5000); continue; }",
    "      const json = await res.json();",
    "      const edge = json.data.user[key];",
    "      edge.edges.forEach(e => users.push({",
    "        username: e.node.username,",
    "        full_name: e.node.full_name,",
    "        pic: e.node.profile_pic_url,",
    "        id: e.node.id,",
    "        verified: e.node.is_verified",
    "      }));",
    "      hasNext = edge.page_info.has_next_page;",
    "      cursor = edge.page_info.end_cursor;",
    '      console.log(type + ": " + users.length + " loaded...");',
    "      await wait(2000 + Math.random() * 1500);",
    "    }",
    "    return users;",
    "  }",
    "",
    '  console.log("Fetching followers...");',
    '  const followers = await fetchList("followers");',
    '  console.log("Fetching following...");',
    '  const following = await fetchList("following");',
    "",
    "  const payload = JSON.stringify({",
    "    followers, following, exported: new Date().toISOString()",
    "  });",
    '  const blob = new Blob([payload], { type: "application/json" });',
    "  const a = document.createElement(\"a\");",
    "  a.href = URL.createObjectURL(blob);",
    '  a.download = "instaclean_export.json";',
    "  a.click();",
    '  console.log("Done! Import the file into InstaClean.");',
    "})();",
  ].join("\n");
}

function buildUnfollowScript(usernames) {
  const list = Array.from(usernames);
  return [
    "// InstaClean — Unfollow Script",
    "// " + list.length + " account(s) queued",
    "// Paste this in your browser console on instagram.com",
    "",
    "(async () => {",
    '  const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1];',
    '  if (!csrf) return alert("Log into Instagram first.");',
    "  const wait = ms => new Promise(r => setTimeout(r, ms));",
    "  const targets = " + JSON.stringify(list) + ";",
    "  let done = 0;",
    "",
    "  for (const name of targets) {",
    "    try {",
    '      const search = await fetch("https://www.instagram.com/web/search/topsearch/?query=" + name);',
    "      const data = await search.json();",
    "      const found = data.users?.find(u => u.user.username === name);",
    '      if (!found) { console.warn("Not found: " + name); continue; }',
    '      const res = await fetch("https://www.instagram.com/web/friendships/" + found.user.pk + "/unfollow/", {',
    '        method: "POST",',
    "        headers: {",
    '          "x-csrftoken": csrf,',
    '          "x-requested-with": "XMLHttpRequest",',
    '          "content-type": "application/x-www-form-urlencoded"',
    "        },",
    '        credentials: "include"',
    "      });",
    "      done++;",
    '      console.log("Unfollowed " + done + "/" + targets.length + ": @" + name + (res.ok ? "" : " [FAILED]"));',
    "      await wait(4000 + Math.random() * 3000);",
    "    } catch (e) {",
    '      console.error("Error for @" + name + ":", e);',
    "      await wait(8000);",
    "    }",
    "  }",
    '  console.log("Complete — " + done + " account(s) unfollowed.");',
    "})();",
  ].join("\n");
}

// ── Data parser — handles multiple export formats ────────────────────
// Instagram's official "Download your information" export splits followers
// and following into separate files (followers_1.json is a bare array,
// following.json is wrapped in { relationships_following: [...] }), so a
// single import can only ever supply one side of the picture at a time.
// This inspects one parsed JSON file and reports which side(s) it covers.
function parseExportFile(json, filename = "") {
  // InstaClean / console script format — one file, both sides
  if (json && !Array.isArray(json) && json.followers && json.following) {
    return {
      followers: json.followers.map(normalizeUser),
      following: json.following.map(normalizeUser),
    };
  }
  // Official export, following.json (or a manually wrapped followers file)
  if (json && json.relationships_following) {
    return { following: extractOfficialList(json.relationships_following) };
  }
  if (json && json.relationships_followers) {
    return { followers: extractOfficialList(json.relationships_followers) };
  }
  // Official export, followers_1.json — a bare array with no side marker,
  // so fall back to the filename to tell followers and following apart.
  if (Array.isArray(json)) {
    const list = extractOfficialList(json);
    return filename.toLowerCase().includes("following")
      ? { following: list }
      : { followers: list };
  }
  return null;
}

function normalizeUser(u) {
  return {
    username: u.username || "",
    fullName: u.full_name || u.fullName || "",
    pic: u.pic || u.profile_pic_url || "",
    id: u.id || "",
    verified: u.verified || u.is_verified || false,
  };
}

function extractOfficialList(list) {
  if (!Array.isArray(list)) return [];
  return list.map(entry => ({
    username: entry.string_list_data?.[0]?.value || entry.value || "",
    fullName: "",
    pic: "",
    id: "",
    verified: false,
  }));
}

// ── Avatar with broken-image fallback ──────────────────────────────────
function Avatar({ user }) {
  const [broken, setBroken] = useState(false);
  const letter = (user.username[0] || "?").toUpperCase();
  return (
    <div style={S.avatar}>
      {user.pic && !broken ? (
        <img src={user.pic} alt={"@" + user.username} style={S.avatarImg} onError={() => setBroken(true)} />
      ) : (
        <span style={S.avatarLetter}>{letter}</span>
      )}
    </div>
  );
}

// ── Changes since the previous scan ────────────────────────────────────
function ChangesPanel({ diff }) {
  if (!diff) return null;

  if (diff.empty) {
    return (
      <div style={S.empty}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>✨</div>
        <div style={S.emptyText}>No changes since your last scan.</div>
      </div>
    );
  }

  const sections = [
    { key: "newFollowers", title: "New followers", sign: "+", color: "#10B981", items: diff.newFollowers },
    { key: "lostFollowers", title: "Unfollowed you", sign: "−", color: "#EF4444", items: diff.lostFollowers },
    { key: "newFollowing", title: "You followed", sign: "+", color: "#10B981", items: diff.newFollowing },
    { key: "lostFollowing", title: "You unfollowed", sign: "−", color: "#EF4444", items: diff.lostFollowing },
  ].filter(s => s.items.length > 0);

  return (
    <div>
      {sections.map(s => (
        <div key={s.key} style={S.changeSection}>
          <div style={S.changeHead}>
            <span style={{ ...S.changeSign, color: s.color }}>{s.sign}</span>
            <h3 style={S.changeTitle}>{s.title}</h3>
            <span style={{ ...S.tabCount, background: s.color + "20", color: s.color }}>{s.items.length}</span>
          </div>
          <div style={S.grid}>
            {s.items.map(user => (
              <div key={user.username} style={S.uCard}>
                <div style={S.uTop}>
                  <Avatar user={user} />
                  <span style={{ ...S.badge, background: s.color + "18", color: s.color }}>{s.sign}</span>
                </div>
                <div style={{ marginBottom: 10 }}>
                  <div style={S.uName}>
                    @{user.username}
                    {user.verified && <span style={S.uVerified}> ✓</span>}
                  </div>
                  {user.fullName && <div style={S.uFull}>{user.fullName}</div>}
                </div>
                <div style={S.uActions}>
                  <a
                    href={"https://instagram.com/" + user.username}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={S.profBtn}
                  >
                    Profile
                  </a>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Animated number ──────────────────────────────────────────────────
function Counter({ value, duration = 800 }) {
  const [n, setN] = useState(0);
  const raf = useRef(null);

  useEffect(() => {
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min((now - t0) / duration, 1);
      setN(Math.round((1 - Math.pow(1 - p, 3)) * value));
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [value, duration]);

  return <span>{n.toLocaleString()}</span>;
}

// ── Main component ───────────────────────────────────────────────────
export default function InstaClean() {
  const [view, setView] = useState("home");
  const [data, setData] = useState(null);
  const [previousData, setPreviousData] = useState(null);
  const [tab, setTab] = useState("unfollowers");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("alpha");
  const [whitelist, setWhitelist] = useState(new Set());
  const [selected, setSelected] = useState(new Set());
  const [modal, setModal] = useState(null);
  const [copied, setCopied] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [scanDate, setScanDate] = useState(null);
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const fileRef = useRef(null);

  // ── Persistence ──
  useEffect(() => {
    (async () => {
      try {
        const raw = localStorage.getItem(STORE_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (saved.whitelist) setWhitelist(new Set(saved.whitelist));
        if (saved.history) setHistory(saved.history);
        if (saved.data) {
          setData(saved.data);
          setPreviousData(saved.previousData || null);
          setScanDate(saved.scanDate);
          setView("dashboard");
        }
      } catch (_) { /* first visit */ }
    })();
  }, []);

  const persist = useCallback(async (patch) => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const prev = raw ? JSON.parse(raw) : {};
      localStorage.setItem(STORE_KEY, JSON.stringify({ ...prev, ...patch }));
    } catch (_) {}
  }, []);

  // ── Computed lists ──
  const lists = useMemo(() => {
    if (!data) return { unfollowers: [], fans: [], mutuals: [] };
    const followerNames = new Set(data.followers.map(u => u.username));
    const followingNames = new Set(data.following.map(u => u.username));
    return {
      unfollowers: data.following.filter(u => !followerNames.has(u.username)),
      fans: data.followers.filter(u => !followingNames.has(u.username)),
      mutuals: data.followers.filter(u => followingNames.has(u.username)),
    };
  }, [data]);

  // Changes since the previous scan (null until a second scan has run)
  const diff = useMemo(() => {
    if (!data || !previousData) return null;
    const prevFollowers = new Set(previousData.followers.map(u => u.username));
    const prevFollowing = new Set(previousData.following.map(u => u.username));
    const curFollowers = new Set(data.followers.map(u => u.username));
    const curFollowing = new Set(data.following.map(u => u.username));
    const newFollowers = data.followers.filter(u => !prevFollowers.has(u.username));
    const lostFollowers = previousData.followers.filter(u => !curFollowers.has(u.username));
    const newFollowing = data.following.filter(u => !prevFollowing.has(u.username));
    const lostFollowing = previousData.following.filter(u => !curFollowing.has(u.username));
    if (!newFollowers.length && !lostFollowers.length && !newFollowing.length && !lostFollowing.length) {
      return { empty: true };
    }
    return { newFollowers, lostFollowers, newFollowing, lostFollowing };
  }, [data, previousData]);

  const filtered = useMemo(() => {
    let list =
      tab === "unfollowers" ? lists.unfollowers :
      tab === "fans" ? lists.fans :
      tab === "mutuals" ? lists.mutuals :
      tab === "whitelist" ? lists.unfollowers.filter(u => whitelist.has(u.username)) :
      [];

    if (query) {
      const q = query.toLowerCase();
      list = list.filter(u =>
        u.username.toLowerCase().includes(q) ||
        u.fullName.toLowerCase().includes(q)
      );
    }

    return sort === "name"
      ? _.sortBy(list, u => (u.fullName || u.username).toLowerCase())
      : _.sortBy(list, u => u.username.toLowerCase());
  }, [tab, lists, query, sort, whitelist]);

  // ── Actions ──
  const importFiles = useCallback(async (files) => {
    let followers = null;
    let following = null;
    try {
      for (const file of files) {
        const text = await file.text();
        const part = parseExportFile(JSON.parse(text), file.name);
        if (!part) continue;
        if (part.followers) followers = part.followers;
        if (part.following) following = part.following;
      }
    } catch (_) {
      alert("Failed to read file. Make sure it's valid JSON.");
      return;
    }

    if (!followers || !following) {
      alert(
        !followers && !following
          ? "Unrecognized format. Use the console script or Instagram's data export."
          : "Missing your " + (!followers ? "followers" : "following") +
            " file — select both files from your Instagram export " +
            "(e.g. followers_1.json and following.json) at once, or use " +
            "the console script which exports everything in one file."
      );
      return;
    }

    const parsed = { followers, following };
    const prevSnapshot = data;
    const now = new Date().toISOString();
    setData(parsed);
    setPreviousData(prevSnapshot);
    setScanDate(now);
    setView("dashboard");
    setTab(prevSnapshot ? "changes" : "unfollowers");

    const followerSet = new Set(parsed.followers.map(u => u.username));
    const entry = {
      date: now,
      followers: parsed.followers.length,
      following: parsed.following.length,
      unfollowers: parsed.following.filter(u => !followerSet.has(u.username)).length,
    };
    const next = [...history, entry].slice(-30);
    setHistory(next);
    persist({ data: parsed, previousData: prevSnapshot, scanDate: now, history: next });
  }, [data, history, persist]);

  const toggleWL = useCallback((username) => {
    setWhitelist(prev => {
      const next = new Set(prev);
      next.has(username) ? next.delete(username) : next.add(username);
      persist({ whitelist: [...next] });
      return next;
    });
  }, [persist]);

  const toggleSel = useCallback((username) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(username) ? next.delete(username) : next.add(username);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(prev =>
      prev.size === filtered.length ? new Set() : new Set(filtered.map(u => u.username))
    );
  }, [filtered]);

  const exportCSV = useCallback(() => {
    const label = TABS.find(t => t.id === tab)?.label || tab;
    const rows = [["username", "full_name", "category"]];
    filtered.forEach(u => rows.push([u.username, u.fullName, label]));
    const csv = rows.map(r => r.map(c => '"' + c.replace(/"/g, '""') + '"').join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "instaclean_" + tab + "_" + new Date().toISOString().slice(0, 10) + ".csv";
    a.click();
  }, [filtered, tab]);

  // Non-destructive: go back to the import screen but keep the current
  // scan around as `previousData` so the next import can diff against it.
  const scanAgain = useCallback(() => {
    setView("home");
  }, []);

  const resetAll = useCallback(async () => {
    if (!window.confirm("Start a new scan? This clears your current results, whitelist, and scan history.")) return;
    setData(null);
    setPreviousData(null);
    setScanDate(null);
    setSelected(new Set());
    setWhitelist(new Set());
    setHistory([]);
    setTab("unfollowers");
    setView("home");
    try { localStorage.removeItem(STORE_KEY); } catch (_) {}
  }, []);

  const copyToClipboard = useCallback((text) => {
    navigator.clipboard.writeText(text).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 2400); },
      () => alert("Couldn't copy automatically — select the script text and copy it manually.")
    );
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) importFiles(e.dataTransfer.files);
  }, [importFiles]);

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div style={S.root}>
      <style>{CSS}</style>

      {/* Header */}
      <header style={S.header}>
        <div style={S.headerInner}>
          <div
            style={S.logo}
            role="button"
            tabIndex={0}
            onClick={() => setView(data ? "dashboard" : "home")}
            onKeyDown={e => (e.key === "Enter" || e.key === " ") && setView(data ? "dashboard" : "home")}
          >
            <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
              <defs>
                <linearGradient id="iz" x1="0" y1="26" x2="26" y2="0">
                  <stop stopColor="#F59E0B" /><stop offset=".5" stopColor="#EC4899" /><stop offset="1" stopColor="#8B5CF6" />
                </linearGradient>
              </defs>
              <rect x="2" y="2" width="22" height="22" rx="6" stroke="url(#iz)" strokeWidth="2.5" fill="none" />
              <circle cx="13" cy="13" r="5" stroke="url(#iz)" strokeWidth="2" fill="none" />
              <circle cx="20" cy="6" r="1.6" fill="url(#iz)" />
            </svg>
            <span style={S.logoText}>InstaClean</span>
          </div>
          <nav style={S.nav}>
            {data && view === "dashboard" && (
              <>
                <button style={S.navBtn} onClick={() => setShowHistory(h => !h)}>📊 History</button>
                <button style={S.navBtn} onClick={scanAgain} title="Import a new file and compare it against this scan">🔄 Scan again</button>
                <button style={S.navBtn} onClick={resetAll} title="Wipe everything and start over">↻ New scan</button>
              </>
            )}
            {view === "script" && <button style={S.navBtn} onClick={() => setView("home")}>← Back</button>}
          </nav>
        </div>
      </header>

      <main style={S.main}>
        {/* ════════ HOME ════════ */}
        {view === "home" && (
          <div style={S.home}>
            <div style={S.glow} />
            <h1 style={S.heroTitle}>
              See who <span style={S.gradient}>unfollowed</span> you
            </h1>
            <p style={S.heroSub}>
              Analyze your Instagram connections in seconds. Find out who doesn't
              follow you back, discover hidden fans, and clean up your feed.
            </p>

            <div style={S.methods}>
              <div
                style={{ ...S.card, ...(dragOver ? S.cardActive : {}) }}
                role="button"
                tabIndex={0}
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileRef.current?.click()}
                onKeyDown={e => (e.key === "Enter" || e.key === " ") && fileRef.current?.click()}
              >
                <input
                  ref={fileRef} type="file" accept=".json" multiple
                  style={{ display: "none" }}
                  onChange={e => e.target.files?.length && importFiles(e.target.files)}
                />
                <div style={S.cardIcon}>📂</div>
                <h3 style={S.cardTitle}>Import file</h3>
                <p style={S.cardDesc}>
                  Drag & drop or click to import your JSON file(s) — the
                  console script output, or both followers_1.json and
                  following.json from an Instagram data export
                </p>
                <span style={S.badge}>Recommended</span>
              </div>

              <div
                style={S.card}
                role="button"
                tabIndex={0}
                onClick={() => setView("script")}
                onKeyDown={e => (e.key === "Enter" || e.key === " ") && setView("script")}
              >
                <div style={S.cardIcon}>⚡</div>
                <h3 style={S.cardTitle}>Console script</h3>
                <p style={S.cardDesc}>
                  Copy a script to paste in your browser console
                  while on instagram.com
                </p>
                <span style={{ ...S.badge, background: "rgba(139,92,246,0.12)", color: "#A78BFA" }}>Advanced</span>
              </div>
            </div>

            <div style={S.features}>
              {[
                { i: "🔍", t: "Detection", d: "Find who doesn't follow you back" },
                { i: "👻", t: "Hidden fans", d: "Discover silent followers" },
                { i: "🤍", t: "Whitelist", d: "Protect accounts from analysis" },
                { i: "📊", t: "History", d: "Track changes over time" },
                { i: "⛔", t: "Bulk unfollow", d: "Generate unfollow scripts" },
                { i: "🔒", t: "100% private", d: "Data never leaves your device" },
              ].map((f, i) => (
                <div key={i} style={S.feat}>
                  <span style={S.featIcon}>{f.i}</span>
                  <div>
                    <div style={S.featTitle}>{f.t}</div>
                    <div style={S.featDesc}>{f.d}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ════════ SCRIPT ════════ */}
        {view === "script" && (
          <div style={S.scriptWrap}>
            <h2 style={S.secTitle}>Console Script</h2>
            <p style={S.secDesc}>
              This script fetches your Instagram data and downloads a JSON file
              you can import into InstaClean.
            </p>

            <div style={S.steps}>
              {[
                "Log into instagram.com in your browser",
                "Open the console (F12 → Console, or Ctrl+Shift+J)",
                "Paste the script below and press Enter",
                "Wait for the scan to finish — a JSON file will download",
                "Import the file back into InstaClean",
              ].map((text, i) => (
                <div key={i} style={S.step}>
                  <div style={S.stepN}>{i + 1}</div>
                  <span style={S.stepText}>{text}</span>
                </div>
              ))}
            </div>

            <div style={S.codeWrap}>
              <div style={S.codeHead}>
                <span style={S.codeLang}>JavaScript</span>
                <button
                  style={{ ...S.copyBtn, ...(copied ? { background: "#10B981" } : {}) }}
                  onClick={() => copyToClipboard(buildScanScript())}
                >
                  {copied ? "✓ Copied!" : "Copy script"}
                </button>
              </div>
              <pre style={S.code}><code>{buildScanScript()}</code></pre>
            </div>

            <div style={S.warn}>
              <span style={{ fontSize: 18, flexShrink: 0 }}>⚠️</span>
              <div>
                <strong>Heads up:</strong> Instagram may temporarily rate-limit your
                account if too many requests are sent. The script includes delays
                to minimize this risk. Use responsibly.
              </div>
            </div>

            <button style={{ ...S.primary, marginTop: 20 }} onClick={() => setView("home")}>
              📂 I have my file — import it
            </button>
          </div>
        )}

        {/* ════════ DASHBOARD ════════ */}
        {view === "dashboard" && data && (
          <div style={S.dash}>
            {/* Stats */}
            <div style={S.stats}>
              {[
                { label: "Followers", val: data.followers.length, color: "#10B981", icon: "👥" },
                { label: "Following", val: data.following.length, color: "#6366F1", icon: "➡️" },
                { label: "Don't follow back", val: lists.unfollowers.length, color: "#EF4444", icon: "💔" },
                { label: "Hidden fans", val: lists.fans.length, color: "#F59E0B", icon: "👻" },
                { label: "Mutuals", val: lists.mutuals.length, color: "#10B981", icon: "🤝" },
                { label: "Follow-back rate", val: data.following.length ? Math.round((lists.mutuals.length / data.following.length) * 100) : 0, color: "#8B5CF6", icon: "📈", pct: true },
              ].map((s, i) => (
                <div key={i} style={S.stat}>
                  <div style={{ fontSize: 20, marginBottom: 4 }}>{s.icon}</div>
                  <div style={{ ...S.statVal, color: s.color }}>
                    <Counter value={s.val} />
                    {s.pct && <span style={{ fontSize: 16, marginLeft: 1 }}>%</span>}
                  </div>
                  <div style={S.statLabel}>{s.label}</div>
                </div>
              ))}
            </div>

            {scanDate && (
              <div style={S.scanDate}>
                Last scan: {new Date(scanDate).toLocaleDateString("en-US", {
                  month: "short", day: "numeric", year: "numeric",
                  hour: "2-digit", minute: "2-digit",
                })}
              </div>
            )}

            {/* History panel */}
            {showHistory && history.length > 0 && (
              <div style={S.histPanel}>
                <div style={S.histHead}>
                  <h3 style={{ fontSize: 16, fontWeight: 700 }}>📊 Scan history</h3>
                  <button style={S.x} onClick={() => setShowHistory(false)}>✕</button>
                </div>
                {history.slice().reverse().map((h, i) => (
                  <div key={i} style={S.histRow}>
                    <span>{new Date(h.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
                    <span style={S.histStats}>
                      <span>👥 {h.followers}</span>
                      <span>➡️ {h.following}</span>
                      <span style={{ color: "#EF4444" }}>💔 {h.unfollowers}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Ratio bar */}
            <div style={S.ratio}>
              <div style={S.ratioLabel}>Following breakdown</div>
              <div style={S.ratioTrack}>
                <div style={{
                  height: "100%",
                  width: data.following.length ? (lists.mutuals.length / data.following.length * 100) + "%" : 0,
                  background: "linear-gradient(90deg,#10B981,#34D399)",
                  borderRadius: "8px 0 0 8px",
                  transition: "width 0.8s ease",
                }} />
                <div style={{
                  height: "100%",
                  width: data.following.length ? (lists.unfollowers.length / data.following.length * 100) + "%" : 0,
                  background: "linear-gradient(90deg,#EF4444,#F87171)",
                  borderRadius: "0 8px 8px 0",
                  transition: "width 0.8s ease",
                }} />
              </div>
              <div style={S.ratioLeg}>
                <span><span style={{ ...S.dot, background: "#10B981" }} />Mutuals</span>
                <span><span style={{ ...S.dot, background: "#EF4444" }} />Unfollowers</span>
              </div>
            </div>

            {/* Tabs */}
            <div style={S.tabs}>
              {TABS.filter(t => t.id !== "changes" || diff).map(t => (
                <button
                  key={t.id}
                  style={{
                    ...S.tab,
                    ...(tab === t.id ? { background: t.color + "18", color: t.color, borderColor: t.color + "44" } : {}),
                  }}
                  onClick={() => { setTab(t.id); setQuery(""); setSelected(new Set()); }}
                >
                  <span>{t.icon}</span>
                  <span>{t.label}</span>
                  <span style={{
                    ...S.tabCount,
                    background: tab === t.id ? t.color + "30" : "rgba(255,255,255,0.06)",
                    color: tab === t.id ? t.color : "#8B8A97",
                  }}>
                    {t.id === "unfollowers" ? lists.unfollowers.length
                      : t.id === "fans" ? lists.fans.length
                      : t.id === "mutuals" ? lists.mutuals.length
                      : t.id === "whitelist" ? whitelist.size
                      : diff && !diff.empty
                        ? diff.newFollowers.length + diff.lostFollowers.length + diff.newFollowing.length + diff.lostFollowing.length
                        : 0}
                  </span>
                </button>
              ))}
            </div>

            {tab === "changes" ? (
              <ChangesPanel diff={diff} />
            ) : (
              <>
                {/* Toolbar */}
                <div style={S.toolbar}>
                  <div style={S.search}>
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                      <circle cx="7" cy="7" r="5.5" stroke="#8B8A97" strokeWidth="1.5" />
                      <line x1="11" y1="11" x2="14.5" y2="14.5" stroke="#8B8A97" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                    <input
                      style={S.searchInput}
                      placeholder="Search users..."
                      value={query}
                      onChange={e => setQuery(e.target.value)}
                    />
                    {query && <button style={S.x} onClick={() => setQuery("")}>✕</button>}
                  </div>
                  <div style={S.toolRight}>
                    <select style={S.sel} value={sort} onChange={e => setSort(e.target.value)}>
                      <option value="alpha">A → Z (username)</option>
                      <option value="name">A → Z (name)</option>
                    </select>
                    {filtered.length > 0 && (
                      <>
                        <button style={S.tBtn} onClick={selectAll}>
                          {selected.size === filtered.length ? "Deselect all" : "Select all"}
                        </button>
                        <button style={S.tBtn} onClick={exportCSV}>📥 CSV</button>
                      </>
                    )}
                  </div>
                </div>

                <div style={S.count}>
                  {filtered.length} result{filtered.length !== 1 ? "s" : ""}
                  {query && ' for "' + query + '"'}
                </div>

                {/* Grid */}
                {filtered.length === 0 ? (
                  <div style={S.empty}>
                    <div style={{ fontSize: 40, marginBottom: 16 }}>
                      {tab === "whitelist" ? "🤍" : "🎉"}
                    </div>
                    <div style={S.emptyText}>
                      {tab === "whitelist"
                        ? 'Your whitelist is empty. Add accounts from the "Don\'t follow back" tab.'
                        : query ? "No results for this search." : "No users in this category!"}
                    </div>
                  </div>
                ) : (
                  <div style={S.grid}>
                    {filtered.map(user => (
                      <div
                        key={user.username}
                        style={{
                          ...S.uCard,
                          ...(selected.has(user.username) ? S.uCardSel : {}),
                        }}
                      >
                        <div style={S.uTop}>
                          <div
                            style={S.check}
                            role="checkbox"
                            aria-checked={selected.has(user.username)}
                            aria-label={"Select @" + user.username}
                            tabIndex={0}
                            onClick={() => toggleSel(user.username)}
                            onKeyDown={e => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggleSel(user.username))}
                          >
                            {selected.has(user.username) && (
                              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                                <path d="M3 7l3 3 5-6" stroke="#8B5CF6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            )}
                          </div>
                          <Avatar user={user} />
                          {tab === "unfollowers" && (
                            <button
                              style={{ ...S.wlBtn, ...(whitelist.has(user.username) ? S.wlActive : {}) }}
                              onClick={() => toggleWL(user.username)}
                              title={whitelist.has(user.username) ? "Remove from whitelist" : "Add to whitelist"}
                            >
                              {whitelist.has(user.username) ? "🤍" : "♡"}
                            </button>
                          )}
                          {tab === "whitelist" && (
                            <button style={{ ...S.wlBtn, ...S.wlActive }} onClick={() => toggleWL(user.username)}>✕</button>
                          )}
                        </div>
                        <div style={{ marginBottom: 10 }}>
                          <div style={S.uName}>
                            @{user.username}
                            {user.verified && <span style={S.uVerified}> ✓</span>}
                          </div>
                          {user.fullName && <div style={S.uFull}>{user.fullName}</div>}
                        </div>
                        <div style={S.uActions}>
                          <a
                            href={"https://instagram.com/" + user.username}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={S.profBtn}
                            onClick={e => e.stopPropagation()}
                          >
                            Profile
                          </a>
                          {(tab === "unfollowers" || tab === "whitelist") && (
                            <button style={S.unfBtn} onClick={() => setModal({ users: [user.username] })}>
                              Unfollow
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* Bulk bar */}
            {selected.size > 0 && (
              <div style={S.bulk}>
                <span>{selected.size} selected</span>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {(tab === "unfollowers" || tab === "whitelist") && (
                    <button
                      style={{ ...S.bulkBtn, background: "rgba(239,68,68,0.15)", color: "#F87171" }}
                      onClick={() => setModal({ users: [...selected] })}
                    >
                      ⛔ Unfollow ({selected.size})
                    </button>
                  )}
                  {tab === "unfollowers" && (
                    <button
                      style={S.bulkBtn}
                      onClick={() => {
                        setWhitelist(prev => {
                          const next = new Set(prev);
                          selected.forEach(u => next.add(u));
                          persist({ whitelist: [...next] });
                          return next;
                        });
                        setSelected(new Set());
                      }}
                    >
                      🤍 Whitelist
                    </button>
                  )}
                  <button
                    style={{ ...S.bulkBtn, background: "rgba(255,255,255,0.06)", color: "#8B8A97" }}
                    onClick={() => setSelected(new Set())}
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}

            {/* Unfollow modal */}
            {modal && (
              <div style={S.overlay} onClick={() => setModal(null)}>
                <div style={S.modal} onClick={e => e.stopPropagation()}>
                  <div style={S.modalHead}>
                    <h3 style={{ fontSize: 18, fontWeight: 700 }}>⛔ Unfollow script</h3>
                    <button style={S.x} onClick={() => setModal(null)}>✕</button>
                  </div>
                  <p style={S.modalDesc}>
                    {modal.users.length} account{modal.users.length > 1 ? "s" : ""} selected.
                    Copy this script and paste it in your browser console on <strong>instagram.com</strong>.
                  </p>
                  <div style={S.tags}>
                    {modal.users.slice(0, 10).map(u => (
                      <span key={u} style={S.tag}>@{u}</span>
                    ))}
                    {modal.users.length > 10 && <span style={S.tag}>+{modal.users.length - 10} more</span>}
                  </div>
                  <div style={S.codeWrap}>
                    <pre style={{ ...S.code, maxHeight: 200 }}>
                      <code>{buildUnfollowScript(modal.users)}</code>
                    </pre>
                  </div>
                  <div style={S.warn}>
                    <span style={{ fontSize: 18, flexShrink: 0 }}>⚠️</span>
                    <div>
                      The script unfollows ~1 account every 4–7 seconds to avoid rate limits.
                      Don't close the tab while it's running.
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                    <button
                      style={{ ...S.primary, flex: 1, ...(copied ? { background: "#10B981" } : {}) }}
                      onClick={() => copyToClipboard(buildUnfollowScript(modal.users))}
                    >
                      {copied ? "✓ Copied!" : "Copy script"}
                    </button>
                    <button
                      style={{ ...S.primary, flex: 1, background: "#1C1C27", border: "1px solid rgba(255,255,255,0.1)" }}
                      onClick={() => setModal(null)}
                    >
                      Close
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      <footer style={S.footer}>
        InstaClean — 100% client-side · your data never leaves your device
      </footer>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────
const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #09090E; color: #F1F0F5; }
  ::-webkit-scrollbar { width: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #2A2A35; border-radius: 3px; }
  @keyframes fadeUp { from { opacity:0; transform:translateY(16px); } to { opacity:1; transform:translateY(0); } }
  @keyframes pulse { 0%,100% { opacity:.35; } 50% { opacity:.65; } }
  @keyframes slideUp { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
  select, input, button { font-family: inherit; }
  a { text-decoration: none; color: inherit; }
`;

const S = {
  root: { minHeight: "100vh", display: "flex", flexDirection: "column", background: "#09090E" },

  // Header
  header: { position: "sticky", top: 0, zIndex: 100, borderBottom: "1px solid rgba(255,255,255,0.05)", background: "rgba(9,9,14,0.88)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)" },
  headerInner: { maxWidth: 1140, margin: "0 auto", padding: "0 20px", height: 56, display: "flex", alignItems: "center", justifyContent: "space-between" },
  logo: { display: "flex", alignItems: "center", gap: 9, cursor: "pointer" },
  logoText: { fontSize: 19, fontWeight: 700, background: "linear-gradient(135deg,#F59E0B,#EC4899,#8B5CF6)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", letterSpacing: "-0.03em" },
  nav: { display: "flex", gap: 8 },
  navBtn: { background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.07)", color: "#B0AFBA", padding: "6px 13px", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer" },

  main: { flex: 1, maxWidth: 1140, margin: "0 auto", padding: "20px 20px 60px", width: "100%" },

  // Home
  home: { textAlign: "center", animation: "fadeUp .55s ease", position: "relative" },
  glow: { position: "absolute", top: -120, left: "50%", transform: "translateX(-50%)", width: 480, height: 480, background: "radial-gradient(circle,rgba(139,92,246,.1) 0%,rgba(236,72,153,.05) 40%,transparent 70%)", pointerEvents: "none", animation: "pulse 4s ease infinite" },
  heroTitle: { fontSize: "clamp(30px,5.5vw,52px)", fontWeight: 800, letterSpacing: "-0.04em", lineHeight: 1.1, marginTop: 56, marginBottom: 14, position: "relative" },
  gradient: { background: "linear-gradient(135deg,#EC4899,#8B5CF6)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" },
  heroSub: { fontSize: 16, color: "#8B8A97", maxWidth: 500, margin: "0 auto 44px", lineHeight: 1.6, position: "relative" },
  methods: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(250px,1fr))", gap: 16, maxWidth: 560, margin: "0 auto 50px", position: "relative" },
  card: { background: "#111118", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 16, padding: "28px 22px 24px", cursor: "pointer", transition: "border-color .2s", position: "relative" },
  cardActive: { borderColor: "rgba(139,92,246,.45)", background: "#14142A" },
  cardIcon: { fontSize: 34, marginBottom: 14 },
  cardTitle: { fontSize: 17, fontWeight: 700, marginBottom: 7, letterSpacing: "-0.01em" },
  cardDesc: { fontSize: 13, color: "#8B8A97", lineHeight: 1.5, marginBottom: 14 },
  badge: { display: "inline-block", padding: "3px 11px", borderRadius: 20, fontSize: 11.5, fontWeight: 600, background: "rgba(16,185,129,0.1)", color: "#10B981" },
  features: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", gap: 12, maxWidth: 760, margin: "0 auto", position: "relative" },
  feat: { display: "flex", alignItems: "flex-start", gap: 11, padding: 14, borderRadius: 12, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)", textAlign: "left" },
  featIcon: { fontSize: 20, flexShrink: 0, marginTop: 2 },
  featTitle: { fontSize: 13.5, fontWeight: 600, marginBottom: 3 },
  featDesc: { fontSize: 12, color: "#8B8A97", lineHeight: 1.4 },

  // Script
  scriptWrap: { animation: "fadeUp .45s ease", maxWidth: 680, margin: "0 auto" },
  secTitle: { fontSize: 26, fontWeight: 800, letterSpacing: "-0.03em", marginBottom: 10 },
  secDesc: { color: "#8B8A97", fontSize: 14.5, lineHeight: 1.6, marginBottom: 28 },
  steps: { display: "flex", flexDirection: "column", gap: 10, marginBottom: 28 },
  step: { display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", borderRadius: 10, background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.045)" },
  stepN: { width: 26, height: 26, borderRadius: "50%", background: "linear-gradient(135deg,#8B5CF6,#EC4899)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12.5, fontWeight: 700, flexShrink: 0 },
  stepText: { fontSize: 13.5, color: "#C4C3CF" },
  codeWrap: { borderRadius: 12, overflow: "hidden", border: "1px solid rgba(255,255,255,0.07)", marginBottom: 16 },
  codeHead: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 14px", background: "#161620", borderBottom: "1px solid rgba(255,255,255,0.05)" },
  codeLang: { fontSize: 11.5, color: "#8B8A97", fontWeight: 500 },
  copyBtn: { background: "linear-gradient(135deg,#8B5CF6,#6D28D9)", color: "#fff", border: "none", padding: "5px 14px", borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: "pointer", transition: "background .2s" },
  code: { background: "#0B0B12", padding: "14px 18px", fontSize: 11.5, lineHeight: 1.65, color: "#A5F3C4", fontFamily: "'SF Mono','Fira Code',monospace", overflow: "auto", maxHeight: 300, whiteSpace: "pre-wrap", wordBreak: "break-all" },
  warn: { display: "flex", gap: 11, padding: "12px 16px", borderRadius: 10, background: "rgba(245,158,11,0.07)", border: "1px solid rgba(245,158,11,0.18)", fontSize: 12.5, color: "#FBBF24", lineHeight: 1.5 },
  primary: { background: "linear-gradient(135deg,#8B5CF6,#EC4899)", color: "#fff", border: "none", padding: "11px 24px", borderRadius: 10, fontSize: 14.5, fontWeight: 600, cursor: "pointer" },

  // Dashboard
  dash: { animation: "fadeUp .45s ease" },
  stats: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: 10, marginBottom: 16 },
  stat: { background: "#111118", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 13, padding: "16px 14px 12px", textAlign: "center" },
  statVal: { fontSize: 26, fontWeight: 800, letterSpacing: "-0.03em", fontFamily: "'SF Mono','Fira Code',monospace" },
  statLabel: { fontSize: 11, color: "#8B8A97", marginTop: 3, fontWeight: 500, textTransform: "uppercase", letterSpacing: ".04em" },
  scanDate: { textAlign: "center", fontSize: 11.5, color: "#5A596A", marginBottom: 16 },

  // History
  histPanel: { background: "#111118", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 13, padding: 18, marginBottom: 16, animation: "slideUp .25s ease" },
  histHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 },
  histRow: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 12px", borderRadius: 8, background: "rgba(255,255,255,0.025)", marginBottom: 6, fontSize: 13, color: "#C4C3CF" },
  histStats: { display: "flex", gap: 12, fontSize: 12, color: "#8B8A97" },

  // Changes
  changeSection: { marginBottom: 22 },
  changeHead: { display: "flex", alignItems: "center", gap: 9, marginBottom: 10 },
  changeSign: { fontSize: 18, fontWeight: 800, width: 20, textAlign: "center" },
  changeTitle: { fontSize: 14.5, fontWeight: 700, flex: 1 },

  // Ratio
  ratio: { background: "#111118", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 13, padding: "16px 18px", marginBottom: 16 },
  ratioLabel: { fontSize: 12.5, color: "#8B8A97", fontWeight: 500, marginBottom: 8 },
  ratioTrack: { height: 9, borderRadius: 8, background: "rgba(255,255,255,0.035)", display: "flex", overflow: "hidden", marginBottom: 8 },
  ratioLeg: { display: "flex", gap: 18, fontSize: 11.5, color: "#8B8A97" },
  dot: { display: "inline-block", width: 7, height: 7, borderRadius: "50%", marginRight: 5, verticalAlign: "middle" },

  // Tabs
  tabs: { display: "flex", gap: 7, marginBottom: 14, overflowX: "auto", paddingBottom: 2 },
  tab: { display: "flex", alignItems: "center", gap: 7, padding: "9px 14px", borderRadius: 9, border: "1px solid rgba(255,255,255,0.05)", background: "rgba(255,255,255,0.025)", color: "#8B8A97", fontSize: 13, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", transition: "all .2s" },
  tabCount: { padding: "2px 7px", borderRadius: 11, fontSize: 11.5, fontWeight: 700, fontFamily: "'SF Mono','Fira Code',monospace" },

  // Toolbar
  toolbar: { display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap", alignItems: "center" },
  search: { flex: "1 1 180px", display: "flex", alignItems: "center", gap: 9, padding: "9px 12px", borderRadius: 9, background: "#111118", border: "1px solid rgba(255,255,255,0.06)" },
  searchInput: { flex: 1, background: "none", border: "none", color: "#F1F0F5", fontSize: 13.5, outline: "none" },
  x: { background: "none", border: "none", color: "#8B8A97", cursor: "pointer", fontSize: 14, padding: 0 },
  toolRight: { display: "flex", gap: 7, flexWrap: "wrap" },
  sel: { background: "#111118", border: "1px solid rgba(255,255,255,0.06)", color: "#C4C3CF", padding: "7px 10px", borderRadius: 7, fontSize: 12.5, cursor: "pointer", outline: "none" },
  tBtn: { background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.07)", color: "#C4C3CF", padding: "7px 12px", borderRadius: 7, fontSize: 12.5, fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap" },
  count: { fontSize: 11.5, color: "#5A596A", marginBottom: 12 },

  // Grid
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(195px,1fr))", gap: 9 },
  uCard: { background: "#111118", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 12, padding: 13, transition: "border-color .2s", animation: "slideUp .25s ease" },
  uCardSel: { borderColor: "rgba(139,92,246,.35)", background: "rgba(139,92,246,.04)" },
  uTop: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 9 },
  check: { width: 20, height: 20, borderRadius: "50%", border: "2px solid rgba(255,255,255,0.12)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 },
  avatar: { width: 38, height: 38, borderRadius: "50%", background: "linear-gradient(135deg,#8B5CF6,#EC4899)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0 },
  avatarImg: { width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" },
  avatarLetter: { fontSize: 15, fontWeight: 700, color: "#fff" },
  wlBtn: { background: "none", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 7, width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 13, color: "#8B8A97", transition: "all .2s" },
  wlActive: { borderColor: "rgba(167,139,250,.35)", background: "rgba(167,139,250,.08)" },
  uName: { fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  uVerified: { color: "#3B82F6", fontSize: 11 },
  uFull: { fontSize: 11.5, color: "#5A596A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  uActions: { display: "flex", gap: 5 },
  profBtn: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "6px 0", borderRadius: 7, fontSize: 11.5, fontWeight: 600, color: "#B0AFBA", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.07)", cursor: "pointer" },
  unfBtn: { flex: 1, padding: "6px 0", borderRadius: 7, fontSize: 11.5, fontWeight: 600, color: "#F87171", background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.18)", cursor: "pointer" },

  // Empty
  empty: { textAlign: "center", padding: "52px 20px", background: "rgba(255,255,255,0.015)", borderRadius: 14, border: "1px dashed rgba(255,255,255,0.07)" },
  emptyText: { fontSize: 13.5, color: "#5A596A", maxWidth: 340, margin: "0 auto", lineHeight: 1.55 },

  // Bulk
  bulk: { position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", background: "#18182A", border: "1px solid rgba(139,92,246,.25)", borderRadius: 13, padding: "11px 18px", display: "flex", alignItems: "center", gap: 14, fontSize: 13.5, fontWeight: 600, boxShadow: "0 10px 36px rgba(0,0,0,.55)", animation: "slideUp .25s ease", zIndex: 200 },
  bulkBtn: { background: "rgba(139,92,246,.12)", color: "#A78BFA", border: "none", padding: "7px 14px", borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" },

  // Modal
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,.72)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300, padding: 20, animation: "fadeUp .2s ease" },
  modal: { background: "#111118", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: 22, maxWidth: 520, width: "100%", maxHeight: "85vh", overflow: "auto" },
  modalHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  modalDesc: { fontSize: 13, color: "#8B8A97", lineHeight: 1.5, marginBottom: 12 },
  tags: { display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 14 },
  tag: { padding: "3px 9px", borderRadius: 18, fontSize: 11.5, fontWeight: 500, background: "rgba(239,68,68,.08)", color: "#F87171", border: "1px solid rgba(239,68,68,.14)" },

  // Footer
  footer: { textAlign: "center", padding: "18px 20px", fontSize: 11.5, color: "#3A3948", borderTop: "1px solid rgba(255,255,255,0.03)" },
};
