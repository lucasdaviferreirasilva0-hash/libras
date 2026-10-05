// LIBRAS BRIDGE - configuracao do site de coleta.
//
// Preencha com os dados do SEU projeto Supabase:
//   Supabase > Project Settings > API Keys (e "Data API" para a URL).
//
// A chave daqui e a PUBLICA ("publishable", que comeca com sb_publishable_,
// ou a antiga "anon", que comeca com eyJ). Este arquivo fica visivel para
// qualquer pessoa que abrir o site - por isso NUNCA coloque aqui a chave
// secreta (sb_secret_ / service_role). O site se recusa a funcionar se ela
// for colocada aqui por engano.

export const CONFIG = {
  supabaseUrl: "https://sssrgtkdkslroobzwixl.supabase.co",        // ex.: "https://abcdefghijkl.supabase.co"
  chavePublica: "sb_publishable_UfRT6BB-yDMEBkhmaDoaNQ_jq7UuPKA",       // ex.: "sb_publishable_xxxxxxxx"

  // Meta de gravacoes por letra em CADA sessao. Gravacoes da mesma pessoa
  // no mesmo dia saem quase iguais: mais pessoas vale mais que mais repeticoes.
  amostrasPorLetra: 10,

  // Espera entre apertar "Gravar" e comecar a gravar. 0 = grava na hora
  // (forme a letra ANTES e aperte espaco com a outra mao). Use 2 ou 3 se a
  // pessoa precisar da mesma mao para tocar no botao (celular).
  contagemSegundos: 0,
};
