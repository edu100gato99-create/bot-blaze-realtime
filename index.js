// ============ CONFIG (virá do Render como env vars) ============
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN; // seu token
const CHAT_ID = Number(process.env.CHAT_ID);       // seu chat id (número)

// ============ DEPENDÊNCIAS ============
import TelegramBot from "node-telegram-bot-api";
import { makeConnection } from "@viniciusgdr/blaze";
import express from "express";

// ============ HTTP KEEPALIVE (Render) ============
const app = express();
app.get("/", (req,res)=>res.send("OK"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("HTTP keepalive on", PORT));

// ============ TELEGRAM ============
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Teclado fixo
const keyboard = {
  reply_markup: {
    keyboard: [
      [{ text: "▶️ Iniciar" }, { text: "⏹ Parar" }],
      [{ text: "🧹 Limpar" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  }
};

// Estado
let running = false;
const sentMessages = []; // [{id, ts}]
const HEARTBEAT_MS = 60 * 60 * 1000; // 1h
const AUTODELETE_SEC = 3600;         // 1h

// ============ HISTÓRICO / ESTRATÉGIA ============
const HISTORY_MAX = 400;
const history = [];       // [{roll, color, ts: Date}]
const pendingWhites = []; // brancos aguardando 2 pós
const minutePredMap = new Map(); // minute -> Set(whiteIds) p/ "Muito Forte"
let whiteSeq = 0;
const fortesSet = new Set([5, 7, 8, 9, 12]);
const pad2 = (n) => n.toString().padStart(2,"0");

// Combinações 1..4 números, ignorando zeros (0 = branco)
function combosFromFour(minute, nums) {
  const vals = nums.filter(n => n !== 0 && Number.isFinite(n));
  const out = [];
  const push = (arr) => {
    const sum = arr.reduce((a,b)=>a+b,0);
    out.push({ label: `${minute}+${arr.join("+")}`, minute: (minute + sum) % 60 });
  };
  for (let i=0;i<vals.length;i++) push([vals[i]]);
  for (let i=0;i<vals.length;i++)
    for (let j=i+1;j<vals.length;j++) push([vals[i], vals[j]]);
  for (let i=0;i<vals.length;i++)
    for (let j=i+1;j<vals.length;j++)
      for (let k=j+1;k<vals.length;k++) push([vals[i], vals[j], vals[k]]);
  if (vals.length === 4) push(vals);
  const seen = new Set();
  return out.filter(c => {
    const key = `${c.minute}:${c.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function signalStrength(distance, minuteHit) {
  const base = fortesSet.has(distance) ? "🔥 Forte" : "Sinal";
  const set = minutePredMap.get(minuteHit);
  if (set && set.size >= 2) return "⚡ Muito Forte";
  return base;
}

async function send(text) {
  try {
    const msg = await bot.sendMessage(CHAT_ID, text, keyboard);
    sentMessages.push({ id: msg.message_id, ts: Math.floor(Date.now()/1000) });
  } catch(e) {
    console.log("Erro Telegram:", e?.message || e);
  }
}

// Auto-delete > 1h
function sweepOldMessages() {
  const nowSec = Math.floor(Date.now()/1000);
  for (let i = sentMessages.length - 1; i >= 0; i--) {
    if (nowSec - sentMessages[i].ts >= AUTODELETE_SEC) {
      bot.deleteMessage(CHAT_ID, sentMessages[i].id).catch(()=>{});
      sentMessages.splice(i,1);
    }
  }
}
setInterval(sweepOldMessages, 30_000);

// Heartbeat
setInterval(() => {
  if (running) send("✅ Robô ativo, monitorando Blaze Double em tempo real…");
}, HEARTBEAT_MS);

// Botões
bot.on("message", async (msg) => {
  if (!msg?.text) return;
  const t = msg.text.trim();

  if (t === "/start") {
    await bot.sendMessage(CHAT_ID, "🤖 Controle do bot:", keyboard);
    return;
  }
  if (t === "▶️ Iniciar") {
    if (!running) {
      running = true;
      await send("✅ Sinais INICIADOS! Vou avisar cada previsão que bater.");
    } else {
      await send("⚠️ Já estou rodando.");
    }
    return;
  }
  if (t === "⏹ Parar") {
    running = false;
    await send("🛑 Sinais PARADOS.");
    return;
  }
  if (t === "🧹 Limpar") {
    for (const m of [...sentMessages]) {
      await bot.deleteMessage(CHAT_ID, m.id).catch(()=>{});
    }
    sentMessages.length = 0;
    await send("🧽 Limpeza concluída.");
    return;
  }
});

// Tick handler
function onTick(raw) {
  const roll = Number(raw.roll); // 0 == branco
  const tsStr = raw.created_at || raw.rolled_at || new Date().toISOString();
  const ts = new Date(tsStr);

  history.unshift({ roll, color: Number(raw.color), ts });
  if (history.length > HISTORY_MAX) history.pop();

  // Completa janelas pendentes
  for (const w of pendingWhites) {
    if (!w.completed) {
      const after1 = history[w.idx - 1];
      const after2 = history[w.idx - 2];
      if (after1 && after2) {
        w.completed = true;
        w.after = [after1.roll, after2.roll];

        const before1 = history[w.idx + 1]?.roll ?? null;
        const before2 = history[w.idx + 2]?.roll ?? null;
        const windowNums = [before2, before1, ...w.after].filter(x => x !== null);

        w.predictions = combosFromFour(w.minute, windowNums);

        for (const p of w.predictions) {
          if (!minutePredMap.has(p.minute)) minutePredMap.set(p.minute, new Set());
          minutePredMap.get(p.minute).add(w.id);
        }
      }
    }
  }

  // Validação por minuto
  const nowMinute = ts.getMinutes();
  for (const w of pendingWhites) {
    if (!w.completed || !w.predictions) continue;
    const hits = w.predictions.filter(p => p.minute === nowMinute);
    if (hits.length) {
      const distance = w.idx - 0;
      const strength = signalStrength(distance, nowMinute);
      const labels = hits.map(h => h.label).slice(0, 6).join(" | ");
      send(
        `⚪ Sinal Detectado\n` +
        `🕐 Branco às ${pad2(w.hour)}:${pad2(w.minute)}\n` +
        `🔢 Combinações: ${labels}\n` +
        `🎯 Minuto alvo: ${pad2(nowMinute)}\n` +
        `📏 Distância: ${distance} casas\n` +
        `⭐ Força: ${strength}`
      );
    }
  }

  // Branco atual → criar pendência
  if (roll === 0) {
    const m = ts.getMinutes();
    const h = ts.getHours();
    pendingWhites.push({
      id: ++whiteSeq,
      idx: 0,
      hour: h,
      minute: m,
      ts,
      after: [],
      completed: false,
      predictions: []
    });
    send(`⚪ Branco detectado agora em ${pad2(h)}:${pad2(m)}. Montando janela (2 antes + 2 depois)…`);
  }

  // Reindexa pendências (history.unshift move tudo)
  for (const w of pendingWhites) w.idx++;

  // Limpa antigos (e remove do mapa)
  while (pendingWhites.length && pendingWhites[0].idx > 200) {
    const old = pendingWhites.shift();
    if (old?.predictions) {
      for (const p of old.predictions) {
        const set = minutePredMap.get(p.minute);
        if (set) {
          set.delete(old.id);
          if (set.size === 0) minutePredMap.delete(p.minute);
        }
      }
    }
  }
}

// WebSocket Blaze
function startBlaze() {
  const conn = makeConnection({
    type: "doubles",
    cacheIgnoreRepeatedEvents: true
  });

  conn.ev.on("double.tick", (msg) => {
    try { if (running) onTick(msg); } catch (e) { console.log("tick err:", e?.message || e); }
  });

  conn.ev.on("close", ({ code, reconnect }) => {
    send(`⚠️ WebSocket fechado (code ${code}). Reconnect: ${reconnect ? "sim" : "não"}`);
  });

  send("✅ Conectado ao Blaze Double (tempo real). Use ▶️ Iniciar / ⏹ Parar.");
}

// Boot
startBlaze();
bot.sendMessage(CHAT_ID, "🤖 Bot pronto. Use o teclado abaixo para controlar.", keyboard).catch(()=>{});
