import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;
const WORKER_TOKEN = process.env.WORKER_TOKEN;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkAuth(req, res, next) {
  if (!WORKER_TOKEN) {
    console.warn("WORKER_TOKEN não configurado.");
    return res.status(500).json({
      ok: false,
      error: "WORKER_TOKEN_NOT_CONFIGURED"
    });
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace("Bearer ", "").trim();

  if (token !== WORKER_TOKEN) {
    return res.status(401).json({
      ok: false,
      error: "UNAUTHORIZED"
    });
  }

  next();
}

async function sendCallback(callbackUrl, payload) {
  if (!callbackUrl) {
    console.warn("callbackUrl ausente. Payload:", payload);
    return;
  }

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

    console.log("Callback enviado:", {
      status: response.status,
      body: text
    });
  } catch (error) {
    console.error("Erro ao enviar callback:", error);
  }
}

async function runFakeMeetingJob(job) {
  const {
    jobId,
    meetingUrl,
    platform,
    botName,
    callbackUrl,
    meetingTitle
  } = job;

  console.log("Iniciando job fake:", {
    jobId,
    meetingUrl,
    platform,
    botName,
    meetingTitle
  });

  await sendCallback(callbackUrl, {
    jobId,
    status: "joining",
    message: "OpenTo AI está entrando na reunião."
  });

  await sleep(3000);

  await sendCallback(callbackUrl, {
    jobId,
    status: "waiting_admission",
    message: "Aguardando aprovação do host."
  });

  await sleep(3000);

  await sendCallback(callbackUrl, {
    jobId,
    status: "recording",
    message: "OpenTo AI está gravando a reunião."
  });

  await sleep(6000);

  await sendCallback(callbackUrl, {
    jobId,
    status: "uploading",
    message: "OpenTo AI está enviando o áudio da reunião."
  });

  await sleep(3000);

  await sendCallback(callbackUrl, {
    jobId,
    status: "completed",
    message: "Simulação concluída com sucesso."
  });

  console.log("Job fake concluído:", jobId);
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "OpenTo Meeting Bot Worker",
    mode: "fake-worker",
    status: "online"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "healthy"
  });
});

app.post("/join", checkAuth, async (req, res) => {
  const {
    jobId,
    meetingUrl,
    platform,
    botName,
    callbackUrl,
    tenantId,
    userId,
    meetingTitle
  } = req.body;

  if (!jobId || !meetingUrl || !callbackUrl) {
    return res.status(400).json({
      ok: false,
      error: "MISSING_REQUIRED_FIELDS",
      required: ["jobId", "meetingUrl", "callbackUrl"]
    });
  }

  res.json({
    ok: true,
    jobId,
    status: "queued",
    message: "Job recebido pelo worker."
  });

  runFakeMeetingJob({
    jobId,
    meetingUrl,
    platform,
    botName,
    callbackUrl,
    tenantId,
    userId,
    meetingTitle
  }).catch((error) => {
    console.error("Erro no job fake:", error);

    sendCallback(callbackUrl, {
      jobId,
      status: "failed",
      message: "Erro ao executar simulação do worker.",
      error: error.message
    });
  });
});

app.listen(PORT, () => {
  console.log(`OpenTo Meeting Bot Worker rodando na porta ${PORT}`);
});
