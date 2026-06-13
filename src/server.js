import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import puppeteer from "puppeteer-core";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "500mb" }));

const PORT = process.env.PORT || 80;
const WORKER_TOKEN = process.env.WORKER_TOKEN;
const CHROME_PROFILE_DIR = process.env.CHROME_PROFILE_DIR || "/data/chrome-profile";
const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome-stable";
const DEFAULT_BOT_NAME = process.env.BOT_NAME || "OpenTo AI - Gravando";
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || "/data/recordings";
const MAX_RECORD_SECONDS = Number(process.env.MAX_RECORD_SECONDS || 30);
const ADMISSION_WAIT_MS = Number(process.env.ADMISSION_WAIT_MS || 45000);
const PULSE_SOURCE = process.env.PULSE_SOURCE || "meet_sink.monitor";
const BOT_CAMERA_VIDEO = process.env.BOT_CAMERA_VIDEO || "/app/assets/opento-bot-rec.mp4";
const BOT_CAMERA_Y4M = process.env.BOT_CAMERA_Y4M || "/data/opento-bot-rec.y4m";
const BOT_CAMERA_VIDEO_FALLBACK = process.env.BOT_CAMERA_VIDEO_FALLBACK || "/data/assets/opento-bot-rec.mp4";
const BOT_CAMERA_GENERATE_FALLBACK = String(process.env.BOT_CAMERA_GENERATE_FALLBACK || "true") === "true";
const REUSE_REMOTE_BROWSER = String(process.env.REUSE_REMOTE_BROWSER || "true") === "true";
const AUTO_LEAVE_AFTER_RECORDING = String(process.env.AUTO_LEAVE_AFTER_RECORDING || "true") === "true";
const ADMISSION_POLL_MS = Number(process.env.ADMISSION_POLL_MS || 1500);
const JOIN_SETTLE_MS = Number(process.env.JOIN_SETTLE_MS || 1800);
const POST_JOIN_CLICK_WAIT_MS = Number(process.env.POST_JOIN_CLICK_WAIT_MS || 1200);

let remoteBrowser = null;
let remotePage = null;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function getTokenFromRequest(req) {
  const authHeader = req.headers.authorization || "";
  const bearer = authHeader.replace("Bearer ", "").trim();
  return req.query.token || req.body?.token || bearer || "";
}

function checkAuth(req, res, next) {
  if (!WORKER_TOKEN) return res.status(500).json({ ok: false, error: "WORKER_TOKEN_NOT_CONFIGURED" });
  const token = getTokenFromRequest(req);
  if (token !== WORKER_TOKEN) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  next();
}

function safeFileName(value) {
  return String(value || "recording").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

function removeChromeLocks() {
  const lockFiles = ["SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort"];
  for (const lock of lockFiles) {
    for (const dir of [CHROME_PROFILE_DIR, path.join(CHROME_PROFILE_DIR, "Default")]) {
      const p = path.join(dir, lock);
      try {
        if (fs.existsSync(p)) {
          fs.rmSync(p, { force: true, recursive: true });
          console.log("Chrome lock removido:", p);
        }
      } catch (error) {
        console.warn("Falha ao remover lock:", { p, error: error.message });
      }
    }
  }
}

async function sendCallback(callbackUrl, payload) {
  if (!callbackUrl) return console.warn("callbackUrl ausente", payload);

  try {
    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OpenTo-Bot-Token": WORKER_TOKEN
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    console.log("Callback enviado:", { status: response.status, body: text?.slice(0, 500) });
  } catch (error) {
    console.error("Erro ao enviar callback:", error);
  }
}

async function launchBrowser({ cleanLocks = true } = {}) {
  fs.mkdirSync(CHROME_PROFILE_DIR, { recursive: true });
  if (cleanLocks) removeChromeLocks();

  const chromeArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=site-per-process,TranslateUI",
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
    "--disable-notifications",
    "--window-size=1440,900",
    "--lang=pt-BR",
    "--password-store=basic",
    "--no-first-run",
    "--no-default-browser-check",
    "--start-maximized"
  ];

  if (BOT_CAMERA_Y4M && fs.existsSync(BOT_CAMERA_Y4M)) {
    console.log("Usando vídeo customizado como câmera do bot:", BOT_CAMERA_Y4M);
    chromeArgs.push("--use-fake-device-for-media-stream");
    chromeArgs.push(`--use-file-for-fake-video-capture=${BOT_CAMERA_Y4M}`);
  } else {
    console.log("Vídeo customizado da câmera não encontrado. BOT_CAMERA_Y4M:", BOT_CAMERA_Y4M);
  }

  return puppeteer.launch({
    executablePath: PUPPETEER_EXECUTABLE_PATH,
    headless: false,
    userDataDir: CHROME_PROFILE_DIR,
    defaultViewport: null,
    ignoreDefaultArgs: ["--enable-automation"],
    args: chromeArgs
  });
}

async function preparePage(page) {
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.chrome = window.chrome || { runtime: {} };
    Object.defineProperty(navigator, "languages", { get: () => ["pt-BR", "pt", "en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
  });
}

async function ensureRemotePage() {
  if (remoteBrowser && remotePage && !remotePage.isClosed()) return { browser: remoteBrowser, page: remotePage };
  remoteBrowser = await launchBrowser({ cleanLocks: true });
  remotePage = await remoteBrowser.newPage();
  await preparePage(remotePage);
  return { browser: remoteBrowser, page: remotePage };
}

async function getPageForJoin() {
  if (REUSE_REMOTE_BROWSER && remoteBrowser && remotePage && !remotePage.isClosed()) {
    console.log("Reutilizando a MESMA aba remota logada para /join.");
    await preparePage(remotePage);
    return { browser: remoteBrowser, page: remotePage, shouldCloseBrowser: false, reusedRemote: true };
  }

  console.log("Nenhum remote ativo. Abrindo novo Chrome com perfil persistente.");
  const browser = await launchBrowser({ cleanLocks: true });
  const page = await browser.newPage();
  await preparePage(page);
  return { browser, page, shouldCloseBrowser: true, reusedRemote: false };
}

async function detectPageState(page) {
  return page.evaluate(() => {
    const bodyText = document.body?.innerText || "";
    const lower = bodyText.toLowerCase();

    const waitingHostSignals = [
      "aguarde até que um organizador",
      "wait for a meeting host",
      "someone in the call will let you in",
      "alguém na chamada permitirá sua entrada"
    ];

    const preJoinSignals = [
      "what's your name",
      "qual é seu nome",
      "ask to join",
      "pedir para participar",
      "join now",
      "participar agora",
      "pronto para participar",
      "sign in with your google account",
      "outras formas de participar"
    ];

    const inCallSignals = [
      "sair da chamada",
      "leave call",
      "legendas",
      "captions",
      "apresentar agora",
      "present now",
      "pessoas",
      "people",
      "chat",
      "enviar uma mensagem",
      "mais opções para open to",
      "não é possível mostrar você em um bloco"
    ];

    const hasWaitingHost = waitingHostSignals.some(s => lower.includes(s));
    const appearsPreJoin = preJoinSignals.some(s => lower.includes(s));
    const hasInCallControls = inCallSignals.some(s => lower.includes(s));

    return {
      hasAskToJoin: lower.includes("pedir para participar") || lower.includes("ask to join"),
      hasJoinNow: lower.includes("participar agora") || lower.includes("join now"),
      hasWaitingHost,
      hasWaiting:
        hasWaitingHost ||
        lower.includes("aguardando") ||
        lower.includes("waiting"),
      hasDenied:
        lower.includes("não foi possível participar") ||
        lower.includes("you can't join") ||
        lower.includes("não é possível participar"),
      hasLeaveCall: lower.includes("sair da chamada") || lower.includes("leave call"),
      hasGoogleAccount:
        lower.includes("gerenciar sua conta do google") ||
        lower.includes("manage your google account") ||
        lower.includes("@gmail.com") ||
        lower.includes("open to") ||
        lower.includes("app.opento"),
      signInVisible: lower.includes("sign in") || lower.includes("fazer login"),
      hasInCallControls,
      appearsInCall: hasInCallControls && !appearsPreJoin && !hasWaitingHost,
      appearsPreJoin,
      sample: bodyText.slice(0, 2000)
    };
  });
}

async function clickByText(page, texts, waitAfterMs = 1000) {
  const lowerTexts = texts.map((t) => t.toLowerCase());

  const result = await page.evaluate((lowerTexts) => {
    const elements = Array.from(document.querySelectorAll("button, div[role='button'], span, input, textarea"));

    for (const element of elements) {
      const text = (element.innerText || element.value || element.getAttribute("aria-label") || "").trim().toLowerCase();
      if (!text) continue;

      const matched = lowerTexts.some((target) => text.includes(target));
      if (matched) {
        const clickable = element.closest("button, div[role='button']") || element;
        const rect = clickable.getBoundingClientRect();
        clickable.scrollIntoView({ block: "center", inline: "center" });
        clickable.click();
        return {
          ok: true,
          text,
          tag: clickable.tagName,
          role: clickable.getAttribute("role"),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        };
      }
    }

    return { ok: false };
  }, lowerTexts);

  if (result?.ok) await sleep(waitAfterMs);
  return result?.ok ? result : null;
}

async function strongClickJoinButton(page) {
  let result = await clickByText(page, [
    "pedir para participar",
    "ask to join",
    "participar agora",
    "join now"
  ], 700);

  if (result?.ok) console.log("Clique no botão join via DOM:", result);

  await sleep(500);
  let state = await detectPageState(page);

  if (state.hasAskToJoin || state.hasJoinNow || state.appearsPreJoin) {
    console.log("DOM click não avançou. Tentando clique por coordenadas.");

    const buttonInfo = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll("button, div[role='button']"));
      const targetTexts = ["pedir para participar", "ask to join", "participar agora", "join now"];

      for (const el of candidates) {
        const text = (el.innerText || el.getAttribute("aria-label") || "").trim().toLowerCase();
        if (targetTexts.some(t => text.includes(t))) {
          const rect = el.getBoundingClientRect();
          return {
            ok: true,
            text,
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          };
        }
      }

      return { ok: false };
    });

    if (buttonInfo?.ok) {
      await page.mouse.move(buttonInfo.x, buttonInfo.y);
      await sleep(300);
      await page.mouse.down();
      await sleep(200);
      await page.mouse.up();
      await sleep(900);
      result = { ok: true, method: "coordinate", buttonInfo };
    }
  }

  state = await detectPageState(page);

  if (state.hasAskToJoin || state.hasJoinNow || state.appearsPreJoin) {
    console.log("Coordinate click não avançou. Tentando Enter.");
    await page.keyboard.press("Enter");
    await sleep(900);
    result = { ok: true, method: "enter_fallback", previous: result };
  }

  return { result, stateAfterStrongClick: await detectPageState(page) };
}

async function typeBotNameIfNeeded(page, botName) {
  const typed = await page.evaluate((botName) => {
    const inputs = Array.from(document.querySelectorAll("input, textarea"));
    for (const input of inputs) {
      const label = [
        input.getAttribute("aria-label"),
        input.getAttribute("placeholder"),
        input.name,
        input.id
      ].filter(Boolean).join(" ").toLowerCase();

      const isNameField = label.includes("nome") || label.includes("name") || label.includes("seu nome") || label.includes("your name");
      if (isNameField || inputs.length === 1) {
        input.focus();
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.value = botName;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, label, inputs: inputs.length };
      }
    }
    return { ok: false, count: inputs.length };
  }, botName);
  if (typed?.ok) await sleep(1000);
  return typed;
}

async function ensureCameraOnMicOff(page) {
  const attempts = [];

  const controls = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll("button, div[role='button']"));
    return elements.map((el) => {
      const label = (el.getAttribute("aria-label") || el.innerText || "").trim();
      const rect = el.getBoundingClientRect();
      return { label, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }).filter(item => item.label);
  });

  for (const item of controls) {
    const label = item.label.toLowerCase();

    const shouldTurnMicOff =
      label.includes("desativar microfone") ||
      label.includes("turn off microphone");

    if (shouldTurnMicOff) {
      await page.mouse.click(item.x, item.y);
      attempts.push({ action: "mic_off", ...item });
      await sleep(500);
    }
  }

  await sleep(500);

  const cameraControls = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll("button, div[role='button']"));
    return elements.map((el) => {
      const label = (el.getAttribute("aria-label") || el.innerText || "").trim();
      const rect = el.getBoundingClientRect();
      return { label, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }).filter(item => item.label);
  });

  for (const item of cameraControls) {
    const label = item.label.toLowerCase();

    const shouldTurnCameraOn =
      label.includes("ativar câmera") ||
      label.includes("ativar camera") ||
      label.includes("turn on camera");

    if (shouldTurnCameraOn) {
      await page.mouse.click(item.x, item.y);
      attempts.push({ action: "camera_on", ...item });
      await sleep(700);
    }
  }

  return attempts;
}

async function tryJoinMeet(page, botName) {
  const actions = [];
  await sleep(JOIN_SETTLE_MS);
  actions.push({ step: "initial_state", state: await detectPageState(page) });

  const nameResult = await typeBotNameIfNeeded(page, botName);
  actions.push({ step: "type_name", result: nameResult });

  const mediaResult = await ensureCameraOnMicOff(page);
  actions.push({ step: "ensure_camera_on_mic_off", result: mediaResult });

  await sleep(400);

  const strongClick = await strongClickJoinButton(page);
  actions.push({ step: "strong_click_join", result: strongClick });

  await sleep(POST_JOIN_CLICK_WAIT_MS);
  actions.push({ step: "after_join_state", state: await detectPageState(page) });
  return actions;
}

function startAudioRecording(jobId) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  const filePath = path.join(RECORDINGS_DIR, `${safeFileName(jobId)}-${Date.now()}.webm`);

  const args = [
    "-y",
    "-f", "pulse",
    "-i", PULSE_SOURCE,
    "-t", String(MAX_RECORD_SECONDS),
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "libopus",
    "-b:a", "32k",
    filePath
  ];

  console.log("Iniciando FFmpeg:", { command: "ffmpeg " + args.join(" "), filePath });

  const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

  ffmpeg.stderr.on("data", (data) => {
    const text = data.toString();
    if (text.includes("time=") || text.toLowerCase().includes("error")) {
      console.log("ffmpeg stderr:", text.slice(0, 1000));
    }
  });

  const done = new Promise((resolve, reject) => {
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      console.log("FFmpeg finalizado:", { code, filePath });
      if (code === 0 || fs.existsSync(filePath)) resolve({ filePath, code });
      else reject(new Error(`FFmpeg exited with code ${code}`));
    });
  });

  return { filePath, process: ffmpeg, done };
}


async function forceCameraOnAfterAdmission(page) {
  const attempts = [];

  for (let i = 0; i < 5; i++) {
    const controls = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll("button, div[role='button']"));
      return elements.map((el) => {
        const label = (el.getAttribute("aria-label") || el.innerText || "").trim();
        const rect = el.getBoundingClientRect();
        return { label, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }).filter(item => item.label);
    });

    let clickedMic = false;
    for (const item of controls) {
      const label = item.label.toLowerCase();

      if (
        label.includes("desativar microfone") ||
        label.includes("turn off microphone")
      ) {
        await page.mouse.click(item.x, item.y);
        clickedMic = true;
        attempts.push({ round: i + 1, action: "mic_off_after_admission", label: item.label, x: item.x, y: item.y });
        await sleep(500);
      }
    }

    await sleep(400);

    const cameraControls = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll("button, div[role='button']"));
      return elements.map((el) => {
        const label = (el.getAttribute("aria-label") || el.innerText || "").trim();
        const rect = el.getBoundingClientRect();
        return { label, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }).filter(item => item.label);
    });

    let clickedCamera = false;
    for (const item of cameraControls) {
      const label = item.label.toLowerCase();

      if (
        label.includes("ativar câmera") ||
        label.includes("ativar camera") ||
        label.includes("turn on camera")
      ) {
        await page.mouse.click(item.x, item.y);
        clickedCamera = true;
        attempts.push({ round: i + 1, action: "camera_on_after_admission", label: item.label, x: item.x, y: item.y });
        await sleep(1000);
      }
    }

    await sleep(700);

    const stateAfter = await detectMeetState(page);
    const sample = String(stateAfter.sample || "").toLowerCase();

    attempts.push({
      round: i + 1,
      action: "post_admission_camera_check",
      clickedCamera,
      clickedMic,
      sample: stateAfter.sample
    });

    const stillHasTurnCameraOnButton =
      sample.includes("ativar câmera") ||
      sample.includes("ativar camera") ||
      sample.includes("turn on camera");

    const stillHasTurnMicOffButton =
      sample.includes("desativar microfone") ||
      sample.includes("turn off microphone");

    if (!stillHasTurnCameraOnButton && !stillHasTurnMicOffButton) {
      break;
    }
  }

  return attempts;
}


async function waitForRealAdmission(page, callbackUrl, jobId) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < ADMISSION_WAIT_MS) {
    const state = await detectPageState(page);
    console.log("Checando entrada real:", { jobId, state });

    if (state.hasDenied) return { admitted: false, denied: true, state };

    if (state.hasWaitingHost) {
      await sendCallback(callbackUrl, {
        jobId,
        status: "waiting_admission",
        message: "OpenTo AI pediu entrada e está aguardando aprovação do host."
      });
    }

    if (state.appearsInCall) {
      return { admitted: true, state };
    }

    await sleep(ADMISSION_POLL_MS);
  }

  return { admitted: false, timeout: true, state: await detectPageState(page) };
}

async function leaveCall(page) {
  try {
    console.log("Tentando sair da chamada rapidamente.");

    // Atalho padrão do Google Meet para sair da chamada.
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyW");
    await page.keyboard.up("Control");
    await sleep(700);

    let stateAfterShortcut = await detectPageState(page);
    if (!stateAfterShortcut.appearsInCall) {
      console.log("Bot saiu da chamada via atalho Ctrl+W ou saiu da tela da reunião.");
      return true;
    }

    const leave = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll("button, div[role='button']"));
      const targets = ["sair da chamada", "leave call"];

      for (const el of elements) {
        const label = (el.getAttribute("aria-label") || el.innerText || "").trim().toLowerCase();
        if (targets.some(t => label.includes(t))) {
          const rect = el.getBoundingClientRect();
          return { ok: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, label };
        }
      }

      return { ok: false };
    });

    if (leave?.ok) {
      await page.mouse.move(leave.x, leave.y);
      await sleep(100);
      await page.mouse.down();
      await sleep(80);
      await page.mouse.up();
      await sleep(700);
      console.log("Bot saiu da chamada via botão:", leave);
      return true;
    }

    console.log("Botão sair da chamada não encontrado.");
    return false;
  } catch (error) {
    console.warn("Erro ao sair da chamada:", error.message);
    return false;
  }
}

async function runRecorderV46(job) {
  const { jobId, meetingUrl, platform, botName, callbackUrl, meetingTitle } = job;
  const finalBotName = botName || DEFAULT_BOT_NAME;

  console.log("Iniciando job Recorder v4.10.2:", { jobId, meetingUrl, platform, botName: finalBotName, meetingTitle });

  let browser;
  let page;
  let shouldCloseBrowser = true;
  let recording;

  try {
    await sendCallback(callbackUrl, { jobId, status: "joining", message: "OpenTo AI está preparando o navegador logado na VPS." });

    const session = await getPageForJoin();
    browser = session.browser;
    page = session.page;
    shouldCloseBrowser = session.shouldCloseBrowser;

    await sendCallback(callbackUrl, {
      jobId,
      status: "joining",
      message: session.reusedRemote ? "OpenTo AI reutilizou a aba remota logada." : "OpenTo AI abriu novo Chrome com perfil persistente."
    });

    await sendCallback(callbackUrl, { jobId, status: "joining", message: "OpenTo AI está acessando o link da reunião." });

    await page.goto(meetingUrl, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(5000);

    console.log("Página carregada:", { jobId, title: await page.title(), currentUrl: page.url() });

    const preJoinState = await detectPageState(page);
    console.log("Estado pré-join:", { jobId, preJoinState });

    await sendCallback(callbackUrl, { jobId, status: "joining", message: "OpenTo AI abriu o Google Meet e está tentando entrar." });

    const actions = await tryJoinMeet(page, finalBotName);
    console.log("Ações Meet Recorder v4.10.2:", { jobId, actions });

    const afterState = actions.find(a => a.step === "after_join_state")?.state || {};

    if (afterState.signInVisible && !afterState.hasGoogleAccount) {
      await sendCallback(callbackUrl, {
        jobId,
        status: "failed",
        message: "O bot ainda está como convidado. Abra /remote, faça login, mantenha o Chrome aberto e teste novamente."
      });
      return;
    }

    const admission = await waitForRealAdmission(page, callbackUrl, jobId);
    console.log("Resultado entrada real:", { jobId, admission });

    if (!admission.admitted) {
      await sendCallback(callbackUrl, {
        jobId,
        status: "failed",
        message: admission.denied
          ? "O Google Meet recusou a entrada do bot."
          : "O bot não entrou na reunião dentro do tempo limite. Gravação não iniciada."
      });
      return;
    }
    const postAdmissionMediaResult = await forceCameraOnAfterAdmission(page);
    actions.push({ step: "force_camera_on_after_admission", result: postAdmissionMediaResult });
    console.log("Correção pós-entrada: câmera ON / microfone OFF:", {
      jobId,
      postAdmissionMediaResult
    });
    await sleep(900);



    await sendCallback(callbackUrl, {
      jobId,
      status: "recording",
      message: `OpenTo AI entrou na reunião e está gravando por até ${MAX_RECORD_SECONDS} segundos.`
    });

    recording = startAudioRecording(jobId);

    await recording.done;

    const filePath = recording.filePath;
    if (!fs.existsSync(filePath)) throw new Error("Arquivo de gravação não foi criado.");

    const stats = fs.statSync(filePath);
    console.log("Arquivo gravado:", { filePath, size: stats.size });

    if (AUTO_LEAVE_AFTER_RECORDING) {
      await leaveCall(page);
    }

    if (stats.size < 1500) {
      await sendCallback(callbackUrl, {
        jobId,
        status: "failed",
        message: "O bot gravou, mas o arquivo de áudio ficou muito pequeno. Verifique se houve áudio na reunião e se o PulseAudio capturou a saída do Chrome.",
        fileSize: stats.size
      });
      return;
    }

    await sendCallback(callbackUrl, {
      jobId,
      status: "uploading",
      message: "OpenTo AI está enviando o áudio gravado para processamento."
    });

    const audioBase64 = fs.readFileSync(filePath).toString("base64");

    await sendCallback(callbackUrl, {
      jobId,
      status: "uploading",
      message: "Áudio gravado enviado para upload e processamento.",
      audioBase64,
      mimeType: "audio/webm",
      durationSeconds: MAX_RECORD_SECONDS,
      fileSize: stats.size
    });

    await sendCallback(callbackUrl, {
      jobId,
      status: "completed",
      message: "Gravação enviada com sucesso. O OpenTo iniciará transcrição e resumo."
    });

    console.log("Job Recorder v4.10.2 concluído:", { jobId, filePath, size: stats.size });
  } catch (error) {
    console.error("Erro no job Recorder v4.10.2:", error);
    await sendCallback(callbackUrl, { jobId, status: "failed", message: "Erro ao executar bot na VPS.", error: error.message });
  } finally {
    if (recording?.process && !recording.process.killed) {
      try { recording.process.kill("SIGINT"); } catch {}
    }

    if (!REUSE_REMOTE_BROWSER && page && !page.isClosed()) {
      try { await page.close(); } catch {}
    }

    if (browser && shouldCloseBrowser) {
      try { await browser.close(); } catch {}
      removeChromeLocks();
    }
  }
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "OpenTo Meeting Bot Worker", mode: "login-recorder-v4.10.2-camera-on-after-admission", status: "online" });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "healthy",
    mode: "login-recorder-v4.10.2-camera-on-after-admission",
    chrome: PUPPETEER_EXECUTABLE_PATH,
    profile: CHROME_PROFILE_DIR,
    pulseSource: PULSE_SOURCE,
    botCameraVideo: BOT_CAMERA_VIDEO,
    botCameraVideoExists: fs.existsSync(BOT_CAMERA_VIDEO),
    botCameraVideoFallback: BOT_CAMERA_VIDEO_FALLBACK,
    botCameraVideoFallbackExists: fs.existsSync(BOT_CAMERA_VIDEO_FALLBACK),
    botCameraGenerateFallback: BOT_CAMERA_GENERATE_FALLBACK,
    botCameraY4m: BOT_CAMERA_Y4M,
    botCameraY4mExists: fs.existsSync(BOT_CAMERA_Y4M),
    maxRecordSeconds: MAX_RECORD_SECONDS,
    admissionWaitMs: ADMISSION_WAIT_MS,
    admissionPollMs: ADMISSION_POLL_MS,
    joinSettleMs: JOIN_SETTLE_MS,
    postJoinClickWaitMs: POST_JOIN_CLICK_WAIT_MS,
    autoLeaveAfterRecording: AUTO_LEAVE_AFTER_RECORDING,
    reuseRemoteBrowser: REUSE_REMOTE_BROWSER,
    remoteBrowserActive: Boolean(remoteBrowser && remotePage && !remotePage.isClosed())
  });
});

app.get("/remote", checkAuth, async (req, res) => {
  const token = getTokenFromRequest(req);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>OpenTo Bot Remote Login</title>
  <style>
    body { font-family: Arial, sans-serif; background: #111; color: #fff; margin: 0; padding: 20px; }
    .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
    input, button { padding: 10px; border-radius: 8px; border: 0; }
    button { cursor: pointer; font-weight: 700; }
    #screen { width: 100%; max-width: 1200px; border: 2px solid #8b5cf6; background: #222; }
    .hint { color: #ccc; font-size: 14px; margin: 8px 0 16px; }
    .warn { color: #fbbf24; font-weight: 700; }
  </style>
</head>
<body>
  <h2>OpenTo Bot Remote Login — v4.10.2</h2>
  <div class="hint">
    Faça login e mantenha esta aba aberta. <span class="warn">A v4.10.2 usa vídeo customizado como câmera, grava após entrada real e sai da chamada após gravar.</span>
  </div>
  <div class="bar">
    <button onclick="start()">Abrir Google Login</button>
    <button onclick="gotoMeet()">Abrir Google Meet</button>
    <button onclick="refresh()">Atualizar print</button>
    <button onclick="status()">Status sessão</button>
    <button onclick="press('Enter')">Enter</button>
    <button onclick="press('Tab')">Tab</button>
    <input id="text" placeholder="Texto para digitar" style="width:360px" />
    <button onclick="typeText()">Digitar</button>
    <input id="url" placeholder="URL" style="width:420px" />
    <button onclick="go()">Ir para URL</button>
  </div>
  <pre id="status" style="white-space:pre-wrap;background:#222;padding:10px;border-radius:8px;max-width:1200px;"></pre>
  <img id="screen" src="/remote/screenshot.png?token=${encodeURIComponent(token)}&t=${Date.now()}" onclick="clickScreen(event)" />
  <script>
    const token = ${JSON.stringify(token)};
    async function api(path, body = {}) {
      const res = await fetch(path + '?token=' + encodeURIComponent(token), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const json = await res.json().catch(() => ({}));
      document.getElementById('status').textContent = JSON.stringify(json, null, 2);
      setTimeout(refresh, 700);
      return json;
    }
    async function apiGet(path) {
      const res = await fetch(path + '?token=' + encodeURIComponent(token));
      const json = await res.json().catch(() => ({}));
      document.getElementById('status').textContent = JSON.stringify(json, null, 2);
      setTimeout(refresh, 700);
      return json;
    }
    function refresh() {
      document.getElementById('screen').src = '/remote/screenshot.png?token=' + encodeURIComponent(token) + '&t=' + Date.now();
    }
    async function start() { await api('/remote/start', { url: 'https://accounts.google.com/' }); }
    async function gotoMeet() { await api('/remote/goto', { url: 'https://meet.google.com/' }); }
    async function status() { await apiGet('/remote/status'); }
    async function go() {
      const url = document.getElementById('url').value;
      await api('/remote/goto', { url });
    }
    async function typeText() {
      const text = document.getElementById('text').value;
      await api('/remote/type', { text });
    }
    async function press(key) { await api('/remote/press', { key }); }
    async function clickScreen(event) {
      const img = event.target;
      const rect = img.getBoundingClientRect();
      const x = Math.round((event.clientX - rect.left) * (1440 / rect.width));
      const y = Math.round((event.clientY - rect.top) * (900 / rect.height));
      await api('/remote/click', { x, y });
    }
    setInterval(refresh, 3000);
  </script>
</body>
</html>`);
});

app.post("/remote/start", checkAuth, async (req, res) => {
  const { url = "https://accounts.google.com/" } = req.body || {};
  const { page } = await ensureRemotePage();
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  const state = await detectPageState(page);
  res.json({ ok: true, url: page.url(), title: await page.title(), state });
});

app.post("/remote/goto", checkAuth, async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: "URL_REQUIRED" });
  const { page } = await ensureRemotePage();
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  const state = await detectPageState(page);
  res.json({ ok: true, url: page.url(), title: await page.title(), state });
});

app.post("/remote/click", checkAuth, async (req, res) => {
  const { x, y } = req.body || {};
  const { page } = await ensureRemotePage();
  await page.mouse.click(Number(x), Number(y));
  await sleep(500);
  const state = await detectPageState(page);
  res.json({ ok: true, x, y, state });
});

app.post("/remote/type", checkAuth, async (req, res) => {
  const { text } = req.body || {};
  const { page } = await ensureRemotePage();
  await page.keyboard.type(String(text || ""), { delay: 30 });
  await sleep(500);
  const state = await detectPageState(page);
  res.json({ ok: true, state });
});

app.post("/remote/press", checkAuth, async (req, res) => {
  const { key } = req.body || {};
  const { page } = await ensureRemotePage();
  await page.keyboard.press(String(key || "Enter"));
  await sleep(500);
  const state = await detectPageState(page);
  res.json({ ok: true, key, state });
});

app.get("/remote/status", checkAuth, async (req, res) => {
  if (!remoteBrowser || !remotePage || remotePage.isClosed()) {
    return res.json({ ok: true, remoteBrowserActive: false, message: "Nenhum navegador remoto ativo." });
  }
  const state = await detectPageState(remotePage);
  res.json({ ok: true, remoteBrowserActive: true, url: remotePage.url(), title: await remotePage.title(), state });
});

app.get("/remote/screenshot.png", checkAuth, async (req, res) => {
  try {
    const { page } = await ensureRemotePage();
    const buffer = await page.screenshot({ type: "png" });
    res.setHeader("Content-Type", "image/png");
    res.end(buffer);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/login-check", checkAuth, async (req, res) => {
  const { page } = await ensureRemotePage();
  await page.goto("https://accounts.google.com/", { waitUntil: "networkidle2", timeout: 60000 });
  const state = await detectPageState(page);
  res.json({ ok: true, url: page.url(), title: await page.title(), state });
});

app.post("/join", checkAuth, async (req, res) => {
  const { jobId, meetingUrl, platform, botName, callbackUrl, tenantId, userId, meetingTitle } = req.body;
  if (!jobId || !meetingUrl || !callbackUrl) {
    return res.status(400).json({ ok: false, error: "MISSING_REQUIRED_FIELDS", required: ["jobId", "meetingUrl", "callbackUrl"] });
  }

  res.json({ ok: true, jobId, status: "queued", mode: "login-recorder-v4.10.2-camera-on-after-admission", message: "Job recebido pelo worker Recorder v4.10.2." });

  runRecorderV46({ jobId, meetingUrl, platform, botName, callbackUrl, tenantId, userId, meetingTitle })
    .catch((error) => console.error("Erro geral no job Recorder v4.10.2:", error));
});

app.listen(PORT, () => {
  console.log(`OpenTo Meeting Bot Worker Login Recorder v4.10.2 rodando na porta ${PORT}`);
});
