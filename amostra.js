// LIBRAS BRIDGE - coleta pela web: montagem das amostras.
//
// Funcoes puras (sem tela, sem camera, sem rede), para poderem ser testadas
// no Node. Reproduzem EXATAMENTE o formato do Python (app/dataset/samples.py):
//
//   landmarks        T x 2 x 21 x 3   (null = vaga sem mao; vira NaN no Python)
//   world_landmarks  T x 2 x 21 x 3
//   hand_present     T x 2            bool
//
// Vaga 0 = "Left" do MediaPipe (Esquerda), vaga 1 = "Right" (Direita), como
// o SampleBuffer do Python. O quadro e espelhado ANTES da deteccao, igual ao
// cv2.flip da coleta no Mac - por isso o rotulo de mao sai na mesma convencao.

export const QUADROS_POR_AMOSTRA = 20;     // igual ao --frames do collect_dataset.py
export const MIN_COMPLETENESS = 0.6;       // igual ao collect_dataset.py
export const CASAS = 5;                    // casas decimais guardadas (0,01 mm no mundo)

const SLOT = { Left: 0, Right: 1 };

function arredonda(valor) {
  const f = 10 ** CASAS;
  return Math.round(valor * f) / f;
}

function pontos(lista) {
  return lista.map((p) => [arredonda(p.x), arredonda(p.y), arredonda(p.z)]);
}

/** Converte o resultado do HandLandmarker de UM quadro para as duas vagas fixas. */
export function frameFromResult(result) {
  const quadro = { landmarks: [null, null], world: [null, null], present: [false, false] };
  const maos = result?.landmarks ?? [];
  const lados = result?.handedness ?? result?.handednesses ?? [];
  maos.forEach((lista, i) => {
    const slot = SLOT[lados[i]?.[0]?.categoryName];
    if (slot === undefined || quadro.present[slot]) return;   // lado desconhecido ou repetido
    if (!lista || lista.length !== 21) return;
    quadro.landmarks[slot] = pontos(lista);
    quadro.world[slot] = pontos(result.worldLandmarks?.[i] ?? lista);
    quadro.present[slot] = true;
  });
  return quadro;
}

/** Fracao de quadros com pelo menos uma mao (0..1), como Sample.completeness. */
export function completeness(quadros) {
  if (!quadros.length) return 0;
  return quadros.filter((q) => q.present[0] || q.present[1]).length / quadros.length;
}

/** Junta os quadros no formato que o banco guarda e o Python importa. */
export function buildSample(quadros) {
  return {
    landmarks: quadros.map((q) => q.landmarks),
    world_landmarks: quadros.map((q) => q.world),
    hand_present: quadros.map((q) => q.present),
  };
}

/** Decide se a amostra vale. Classe de controle (SEM_SINAL) aceita quadro sem mao. */
export function avaliarAmostra(quadros, classe) {
  const fracao = completeness(quadros);
  const precisaMao = classe.tipo !== "controle";
  if (quadros.length < QUADROS_POR_AMOSTRA) {
    return { ok: false, fracao, motivo: "gravacao_incompleta" };
  }
  if (precisaMao && fracao < MIN_COMPLETENESS) {
    return { ok: false, fracao, motivo: "pouca_mao" };
  }
  return { ok: true, fracao };
}

/** Token do convite: vem depois do # no link (o # nao e enviado ao servidor do site). */
export function lerToken(hash) {
  const token = (hash || "").replace(/^#/, "").trim();
  return /^[A-Za-z0-9_-]{20,128}$/.test(token) ? token : null;
}

/** Chave da contagem devolvida pelo banco: "S01/LETRA_A". */
export function chaveContagem(sessao, codigo) {
  return `${sessao}/${codigo}`;
}

/** Chaves antigas do Supabase sao JWT ("eyJ..."); as novas (sb_publishable_) nao. */
export function cabecalhos(chave) {
  const h = { apikey: chave, "Content-Type": "application/json" };
  if (chave.startsWith("eyJ")) h.Authorization = `Bearer ${chave}`;
  return h;
}

/** Mensagem para a pessoa, a partir do erro que a funcao do banco levantou. */
export function mensagemDeErro(codigo) {
  const textos = {
    convite_invalido: "Este link de convite não vale mais. Peça um novo a quem te convidou.",
    sem_consentimento: "Antes de gravar, é preciso aceitar o termo de participação.",
    sessao_invalida: "A sessão de gravação não foi encontrada. Recarregue a página.",
    amostra_invalida: "A gravação chegou com defeito. Tente gravar de novo.",
    limite_atingido: "Você chegou ao limite de gravações. Obrigado!",
  };
  return textos[codigo] ?? "Não foi possível falar com o servidor. Confira a internet e tente de novo.";
}
