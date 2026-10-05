// LIBRAS BRIDGE - site de coleta: telas, camera e envio das amostras.
//
// A imagem da camera NUNCA sai do aparelho: o MediaPipe roda aqui no
// navegador e so as coordenadas dos 21 pontos da mao vao para o banco.

import {
  FilesetResolver,
  HandLandmarker,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs";
import { CONFIG } from "./config.js";
import {
  QUADROS_POR_AMOSTRA,
  avaliarAmostra,
  buildSample,
  cabecalhos,
  chaveContagem,
  frameFromResult,
  lerToken,
  mensagemDeErro,
} from "./amostra.js";

// A MESMA versao do requirements.txt (mediapipe==0.10.35) e o MESMO arquivo de
// modelo do scripts/download_models.py: os pontos saem iguais aos do Python.
const MP_VERSAO = "0.10.35";
const WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSAO}/wasm`;
const MODELO =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const CONTAGEM_MS = Math.max(0, Number(CONFIG.contagemSegundos) || 0) * 1000;
const META = Math.max(1, Number(CONFIG.amostrasPorLetra) || 10);

const TELAS = ["tela-status", "tela-termo", "tela-sessao", "tela-gravar"];
const CONDICOES_TEXTO = {
  natural: "luz do dia", artificial: "lâmpada", fraca: "pouca luz",
  liso: "parede lisa", baguncado: "fundo com coisas",
  perto: "perto", medio: "médio", longe: "longe", nao_informado: "—",
};

const $ = (id) => document.getElementById(id);

const estado = {
  token: null,
  participante: null,
  consentiu: false,
  sessoes: [],
  contagem: {},          // "S01/LETRA_A" -> n
  classes: [],
  sessao: null,
  condicoes: null,
  indice: 0,
  desfazer: [],          // [{id, chave, rotulo}]
  landmarker: null,
  video: null,
  gravacao: null,        // {fase, ate, classe, quadros, inicio}
  ultimoTs: 0,
  fps: 0,
  ultimoSelo: 0,
};

// --------------------------------------------------------------- utilidades
function mostrar(tela) {
  for (const id of TELAS) $(id).hidden = id !== tela;
  const temConvite = Boolean(estado.participante);
  $("quem").hidden = !temConvite;
  $("tela-sair").hidden = !(temConvite && estado.consentiu && tela !== "tela-status");
  $("btn-encerrar").hidden = tela !== "tela-gravar";
  $("confirmar-apagar").hidden = true;
}

function falha(titulo, texto) {
  $("status-titulo").textContent = titulo;
  $("status-texto").textContent = texto;
  mostrar("tela-status");
}

function erroEm(id, texto) {
  $(id).textContent = texto;
  $(id).hidden = false;
}

function retorno(texto, bom) {
  const el = $("retorno");
  el.textContent = texto;
  el.className = `retorno ${bom ? "bom" : "ruim"}`;
}

function rotuloDe(classe) {
  return classe.tipo === "controle" ? "Sem sinal" : classe.significado;
}

function contagemDe(classe) {
  return estado.contagem[chaveContagem(estado.sessao, classe.codigo)] ?? 0;
}

function totalGravacoes() {
  return Object.values(estado.contagem).reduce((a, b) => a + b, 0);
}

function chaveEhSecreta(chave) {
  if (chave.startsWith("sb_secret_")) return true;
  if (!chave.startsWith("eyJ")) return false;
  try {
    const parte = chave.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(parte)).role === "service_role";
  } catch {
    return false;
  }
}

function agoraLocalISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function rpc(nome, params) {
  let resp;
  try {
    resp = await fetch(`${CONFIG.supabaseUrl.replace(/\/+$/, "")}/rest/v1/rpc/${nome}`, {
      method: "POST",
      headers: cabecalhos(CONFIG.chavePublica),
      body: JSON.stringify(params),
    });
  } catch {
    throw Object.assign(new Error("rede"), { codigo: "rede" });
  }
  const texto = await resp.text();
  let corpo = null;
  try {
    corpo = texto ? JSON.parse(texto) : null;
  } catch {
    corpo = null;
  }
  if (!resp.ok) {
    const codigo = corpo?.message ?? `http_${resp.status}`;
    throw Object.assign(new Error(codigo), { codigo });
  }
  return corpo;
}

// --------------------------------------------------------------- abertura
async function iniciar() {
  if (!CONFIG.supabaseUrl || !CONFIG.chavePublica) {
    return falha("Site ainda não configurado",
      "Quem organiza a coleta precisa preencher o arquivo config.js (veja docs/03_coleta_web.md).");
  }
  if (chaveEhSecreta(CONFIG.chavePublica)) {
    return falha("Configuração perigosa: o site não vai funcionar",
      "O config.js está com a chave SECRETA do Supabase. Troque pela chave pública e gere uma chave secreta nova no Supabase, porque esta já ficou exposta.");
  }
  estado.token = lerToken(location.hash);
  if (!estado.token) {
    return falha("Abra pelo link do seu convite",
      "Este site só funciona pelo link pessoal que você recebeu. Se o link chegou cortado, peça de novo a quem te convidou.");
  }
  try {
    const resposta = await fetch("vocabulario.json", { cache: "no-cache" });
    estado.classes = (await resposta.json()).classes;
  } catch {
    return falha("Não consegui carregar a lista de letras", "Recarregue a página.");
  }
  await carregarConvite();
}

async function carregarConvite() {
  let info;
  try {
    info = await rpc("abrir_convite", { p_token: estado.token });
  } catch (e) {
    return falha("Não consegui abrir seu convite", mensagemDeErro(e.codigo));
  }
  estado.participante = info.participante;
  estado.consentiu = info.consentiu;
  estado.sessoes = info.sessoes ?? [];
  estado.contagem = info.contagem ?? {};
  $("codigo-participante").textContent = info.participante;
  $("termo-codigo").textContent = info.participante;
  if (estado.consentiu) telaSessao();
  else mostrar("tela-termo");
}

// --------------------------------------------------------------- termo
function atualizarAceite() {
  $("btn-aceitar").disabled = !($("aceite-termo").checked && $("aceite-idade").checked);
}
$("aceite-termo").addEventListener("change", atualizarAceite);
$("aceite-idade").addEventListener("change", atualizarAceite);

$("btn-aceitar").addEventListener("click", async () => {
  $("btn-aceitar").disabled = true;
  $("termo-erro").hidden = true;
  try {
    await rpc("registrar_consentimento", { p_token: estado.token });
    estado.consentiu = true;
    telaSessao();
  } catch (e) {
    erroEm("termo-erro", mensagemDeErro(e.codigo));
    atualizarAceite();
  }
});

// --------------------------------------------------------------- sessao
function totalDaSessao(sessao) {
  return Object.entries(estado.contagem)
    .filter(([chave]) => chave.startsWith(`${sessao}/`))
    .reduce((soma, [, n]) => soma + n, 0);
}

function telaSessao() {
  const lista = $("lista-sessoes");
  lista.replaceChildren();
  for (const s of estado.sessoes) {
    const li = document.createElement("li");
    const nome = document.createElement("b");
    nome.textContent = s.sessao;
    const data = new Date(s.inicio).toLocaleDateString("pt-BR");
    const c = s.condicoes ?? {};
    const cond = [c.iluminacao, c.fundo, c.distancia].map((v) => CONDICOES_TEXTO[v] ?? "—").join(" · ");
    const n = totalDaSessao(s.sessao);
    li.append(nome, ` ${data}`, ` · ${cond}`, ` · ${n} ${n === 1 ? "gravação" : "gravações"}`);
    lista.append(li);
  }
  $("sessoes-anteriores").hidden = estado.sessoes.length === 0;
  const ultima = estado.sessoes.at(-1);
  $("btn-continuar").hidden = !ultima;
  if (ultima) $("btn-continuar").textContent = `Continuar a sessão ${ultima.sessao}`;
  $("btn-nova-sessao").textContent = estado.sessoes.length ? "Começar nova sessão" : "Começar a gravar";
  $("sessao-erro").hidden = true;
  mostrar("tela-sessao");
}

$("form-sessao").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const dados = new FormData(ev.target);
  const condicoes = {
    iluminacao: dados.get("iluminacao"),
    fundo: dados.get("fundo"),
    distancia: dados.get("distancia"),
  };
  $("btn-nova-sessao").disabled = true;
  try {
    const sessao = await rpc("nova_sessao", { p_token: estado.token, p_condicoes: condicoes });
    estado.sessoes.push({ sessao, inicio: new Date().toISOString(), condicoes });
    await entrarNaSessao(sessao, condicoes);
  } catch (e) {
    erroEm("sessao-erro", mensagemDeErro(e.codigo));
  } finally {
    $("btn-nova-sessao").disabled = false;
  }
});

$("btn-continuar").addEventListener("click", () => {
  const ultima = estado.sessoes.at(-1);
  if (ultima) entrarNaSessao(ultima.sessao, ultima.condicoes ?? {});
});

async function entrarNaSessao(sessao, condicoes) {
  estado.sessao = sessao;
  estado.condicoes = condicoes;
  estado.desfazer = [];
  estado.indice = proximaIncompleta(0) ?? 0;
  $("sessao-codigo").textContent = sessao;
  retorno("", true);
  atualizarTudo();
  mostrar("tela-gravar");
  try {
    await ligarCamera();
  } catch (e) {
    $("selo-info").textContent = "câmera desligada";
    retorno(e.message, false);
  }
}

$("btn-encerrar").addEventListener("click", () => {
  if (estado.gravacao) return;
  telaSessao();
});

// --------------------------------------------------------------- camera
async function ligarCamera() {
  if (estado.landmarker && estado.video) return;
  if (!window.isSecureContext) throw new Error("A câmera só funciona com o site aberto por https.");
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Este navegador não dá acesso à câmera. Use Chrome, Edge, Firefox ou Safari atualizados.");
  }
  $("selo-info").textContent = "pedindo permissão da câmera…";
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
      audio: false,
    });
  } catch (e) {
    if (e.name === "NotAllowedError") {
      throw new Error("Você não liberou a câmera. Clique no cadeado ao lado do endereço do site, permita a câmera e recarregue a página.");
    }
    if (e.name === "NotFoundError" || e.name === "OverconstrainedError") {
      throw new Error("Nenhuma câmera encontrada neste aparelho.");
    }
    if (e.name === "NotReadableError") {
      throw new Error("A câmera está sendo usada por outro programa (Zoom, Meet…). Feche-o e recarregue a página.");
    }
    throw new Error("Não consegui abrir a câmera.");
  }
  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.srcObject = stream;
  await video.play();
  estado.video = video;

  $("selo-info").textContent = "carregando o detector de mãos…";
  try {
    const vision = await FilesetResolver.forVisionTasks(WASM);
    // Mesmas opcoes do HandTracker do Python (app/hand_tracking/landmarker.py).
    estado.landmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODELO, delegate: "CPU" },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  } catch {
    throw new Error("Não consegui carregar o detector de mãos. Confira a internet e recarregue a página.");
  }
  atualizarBotoes();          // o botao Gravar so liga agora que o detector existe
  requestAnimationFrame(quadro);
}

const proc = document.createElement("canvas");
const pctx = proc.getContext("2d");
const tela = $("camera");
const tctx = tela.getContext("2d");

function quadro() {
  const v = estado.video;
  if (v && v.readyState >= 2 && v.videoWidth && !$("tela-gravar").hidden) {
    const w = v.videoWidth;
    const h = v.videoHeight;
    if (proc.width !== w || proc.height !== h) {
      proc.width = tela.width = w;
      proc.height = tela.height = h;
    }
    // Espelha ANTES de detectar, como o cv2.flip da coleta no Mac.
    pctx.setTransform(-1, 0, 0, 1, w, 0);
    pctx.drawImage(v, 0, 0, w, h);
    pctx.setTransform(1, 0, 0, 1, 0, 0);

    const ts = Math.max(performance.now(), estado.ultimoTs + 1);
    const intervalo = ts - estado.ultimoTs;
    estado.ultimoTs = ts;
    if (intervalo > 0 && intervalo < 1000) {
      const instantaneo = 1000 / intervalo;
      estado.fps = estado.fps ? estado.fps * 0.9 + instantaneo * 0.1 : instantaneo;
    }

    const resultado = estado.landmarker.detectForVideo(proc, ts);
    tctx.drawImage(proc, 0, 0);
    desenharMaos(resultado, w);

    if (ts - estado.ultimoSelo > 250) {
      estado.ultimoSelo = ts;
      const n = resultado.landmarks.length;
      $("selo-info").textContent = `${n} ${n === 1 ? "mão" : "mãos"} · ${Math.round(estado.fps)} quadros/s`;
    }
    processarGravacao(frameFromResult(resultado), ts);
  }
  requestAnimationFrame(quadro);
}

function desenharMaos(resultado, largura) {
  const escala = largura / 640;
  for (const pts of resultado.landmarks) {
    tctx.strokeStyle = "#3fd6c7";
    tctx.lineWidth = 3 * escala;
    tctx.lineCap = "round";
    for (const { start, end } of HandLandmarker.HAND_CONNECTIONS) {
      tctx.beginPath();
      tctx.moveTo(pts[start].x * tela.width, pts[start].y * tela.height);
      tctx.lineTo(pts[end].x * tela.width, pts[end].y * tela.height);
      tctx.stroke();
    }
    pts.forEach((p, i) => {
      const ponta = [4, 8, 12, 16, 20].includes(i);
      tctx.fillStyle = ponta ? "#ff6b6b" : "#ffffff";
      tctx.beginPath();
      tctx.arc(p.x * tela.width, p.y * tela.height, (ponta ? 5 : 3.5) * escala, 0, Math.PI * 2);
      tctx.fill();
    });
  }
}

// --------------------------------------------------------------- gravacao
function iniciarGravacao() {
  if (estado.gravacao || !estado.landmarker) return;
  estado.gravacao = {
    fase: CONTAGEM_MS > 0 ? "contagem" : "gravando",
    ate: performance.now() + CONTAGEM_MS,
    classe: estado.classes[estado.indice],
    quadros: [],
    inicio: 0,
  };
  retorno("", true);
  atualizarBotoes();
  $("selo-rec").hidden = CONTAGEM_MS > 0;
}

function processarGravacao(quadroAtual, ts) {
  const g = estado.gravacao;
  if (!g) return;
  if (g.fase === "contagem") {
    const falta = g.ate - ts;
    if (falta > 0) {
      $("contagem").textContent = String(Math.ceil(falta / 1000));
      return;
    }
    g.fase = "gravando";
    $("contagem").textContent = "";
    $("selo-rec").hidden = false;
  }
  if (g.fase === "gravando") {
    if (!g.quadros.length) g.inicio = ts;
    g.quadros.push(quadroAtual);
    if (g.quadros.length >= QUADROS_POR_AMOSTRA) {
      g.fase = "enviando";
      g.fps = ((g.quadros.length - 1) * 1000) / Math.max(1, ts - g.inicio);
      $("selo-rec").hidden = true;
      enviar(g);
    }
  }
}

async function enviar(g) {
  const classe = g.classe;
  const rotulo = rotuloDe(classe);
  const avaliacao = avaliarAmostra(g.quadros, classe);
  if (!avaliacao.ok) {
    retorno(`A mão apareceu em só ${Math.round(avaliacao.fracao * 100)}% da gravação. Grave de novo com a mão inteira na imagem.`, false);
    estado.gravacao = null;
    atualizarBotoes();
    return;
  }
  // Mesmos campos do meta do collect_dataset.py, mais a origem.
  const meta = {
    classe: classe.codigo,
    tipo: classe.tipo,
    status: classe.status,
    participante: estado.participante,
    sessao: estado.sessao,
    timestamp: agoraLocalISO(),
    condicoes: estado.condicoes,
    resolucao: [proc.width, proc.height],
    espelhado: true,
    handedness_invertida: false,
    fps_medio: Math.round(g.fps * 100) / 100,
    quadros: g.quadros.length,
    origem: "web",
    mediapipe: MP_VERSAO,
  };
  try {
    const id = await rpc("enviar_amostra", {
      p_token: estado.token,
      p_sessao: estado.sessao,
      p_classe: classe.codigo,
      p_dados: buildSample(g.quadros),
      p_meta: meta,
    });
    const chave = chaveContagem(estado.sessao, classe.codigo);
    estado.contagem[chave] = (estado.contagem[chave] ?? 0) + 1;
    estado.desfazer.push({ id, chave, rotulo });
    const n = estado.contagem[chave];
    if (n >= META && estado.classes[estado.indice] === classe) {
      const proxima = proximaIncompleta(estado.indice + 1);
      if (proxima === null) {
        retorno("Pronto! Você completou todas as letras desta sessão. Muito obrigado!", true);
      } else {
        estado.indice = proxima;
        retorno(`${rotulo} completa! Agora: ${rotuloDe(estado.classes[proxima])}.`, true);
      }
    } else {
      retorno(`Gravado: ${rotulo} (${n} de ${META}).`, true);
    }
  } catch (e) {
    retorno(mensagemDeErro(e.codigo), false);
  } finally {
    estado.gravacao = null;
    atualizarTudo();
  }
}

function proximaIncompleta(inicio) {
  const total = estado.classes.length;
  for (let k = 0; k < total; k++) {
    const i = (inicio + k) % total;
    if (contagemDe(estado.classes[i]) < META) return i;
  }
  return null;
}

function mover(passo) {
  if (estado.gravacao || !estado.classes.length) return;
  const total = estado.classes.length;
  estado.indice = (estado.indice + passo + total) % total;
  retorno("", true);
  atualizarTudo();
}

$("btn-gravar").addEventListener("click", iniciarGravacao);
$("btn-anterior").addEventListener("click", () => mover(-1));
$("btn-proxima").addEventListener("click", () => mover(1));

$("btn-desfazer").addEventListener("click", async () => {
  const ultima = estado.desfazer.pop();
  if (!ultima || estado.gravacao) return;
  $("btn-desfazer").disabled = true;
  try {
    const apagou = await rpc("apagar_amostra", { p_token: estado.token, p_id: ultima.id });
    if (apagou) estado.contagem[ultima.chave] = Math.max(0, (estado.contagem[ultima.chave] ?? 1) - 1);
    retorno(`Apaguei a última gravação de ${ultima.rotulo}.`, true);
  } catch (e) {
    estado.desfazer.push(ultima);
    retorno(mensagemDeErro(e.codigo), false);
  }
  atualizarTudo();
});

document.addEventListener("keydown", (ev) => {
  if ($("tela-gravar").hidden || ev.target.closest?.("input, textarea, select")) return;
  if (ev.code === "Space") {
    ev.preventDefault();
    iniciarGravacao();
  } else if (ev.key === "ArrowRight") {
    mover(1);
  } else if (ev.key === "ArrowLeft") {
    mover(-1);
  }
});

// --------------------------------------------------------------- desenho da tela
function atualizarTudo() {
  mostrarLetra();
  montarGrade();
  atualizarBotoes();
}

function mostrarLetra() {
  const classe = estado.classes[estado.indice];
  if (!classe) return;
  const controle = classe.tipo === "controle";
  const grande = $("letra-grande");
  grande.textContent = rotuloDe(classe);
  grande.classList.toggle("texto", controle);
  $("letra-rotulo").textContent = controle ? "Grave momentos sem letra" : "Faça a letra";
  const n = contagemDe(classe);
  $("letra-meta").textContent = `${n} de ${META} nesta sessão`;
  $("letra-barra").style.width = `${Math.min(100, (n / META) * 100)}%`;
  $("letra-instrucao").textContent = controle
    ? "Mão parada fora de posição, mão saindo da imagem, sem mão nenhuma, coçando o rosto: qualquer coisa que NÃO seja uma letra. Isso ensina o sistema a não inventar letra."
    : `Forme a letra ${classe.significado} do alfabeto manual da Libras com a mão que você usa para escrever e, já com a mão parada, aperte espaço com a outra mão.`;
}

function montarGrade() {
  const grade = $("grade");
  grade.replaceChildren();
  estado.classes.forEach((classe, i) => {
    const n = contagemDe(classe);
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = [i === estado.indice ? "atual" : "", n >= META ? "completa" : ""].join(" ").trim();
    botao.setAttribute("aria-label", `${rotuloDe(classe)}: ${n} de ${META}`);
    const nome = document.createElement("span");
    nome.textContent = classe.tipo === "controle" ? "Ø" : classe.significado;
    const conta = document.createElement("small");
    conta.textContent = `${n}/${META}`;
    botao.append(nome, conta);
    botao.addEventListener("click", () => {
      if (estado.gravacao) return;
      estado.indice = i;
      retorno("", true);
      atualizarTudo();
    });
    grade.append(botao);
  });
}

function atualizarBotoes() {
  const ocupado = Boolean(estado.gravacao);
  $("btn-gravar").disabled = ocupado || !estado.landmarker;
  $("btn-desfazer").disabled = ocupado || estado.desfazer.length === 0;
  $("btn-anterior").disabled = ocupado;
  $("btn-proxima").disabled = ocupado;
  if (!ocupado) $("contagem").textContent = "";
}

// --------------------------------------------------------------- sair do estudo
$("btn-apagar-tudo").addEventListener("click", () => {
  $("total-gravacoes").textContent = String(totalGravacoes());
  $("confirmar-apagar").hidden = false;
});
$("btn-apagar-nao").addEventListener("click", () => {
  $("confirmar-apagar").hidden = true;
});
$("btn-apagar-sim").addEventListener("click", async () => {
  $("btn-apagar-sim").disabled = true;
  try {
    const apagadas = await rpc("apagar_meus_dados", { p_token: estado.token });
    estado.video?.srcObject?.getTracks().forEach((t) => t.stop());
    estado.video = null;
    estado.consentiu = false;
    estado.contagem = {};
    estado.sessoes = [];
    falha("Seus dados foram apagados",
      `${apagadas} ${apagadas === 1 ? "gravação" : "gravações"} e o seu aceite do termo foram removidos. Obrigado por ter participado.`);
  } catch (e) {
    retorno(mensagemDeErro(e.codigo), false);
    $("confirmar-apagar").hidden = true;
  } finally {
    $("btn-apagar-sim").disabled = false;
  }
});

// Colar outro link na mesma aba so troca o que vem depois do #, sem
// recarregar: sem isto o site continuaria com o convite antigo (ou o erro).
window.addEventListener("hashchange", () => location.reload());

iniciar();
