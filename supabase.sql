-- =====================================================================
-- LIBRAS BRIDGE - banco de dados da coleta pela web (Supabase)
--
-- Como usar: no Supabase, abra "SQL Editor" > "New query", cole este
-- arquivo INTEIRO e clique em "Run". Pode rodar de novo quando quiser:
-- nada e apagado.
--
-- COMO OS DADOS FICAM PROTEGIDOS
--   O site usa a chave PUBLICA do projeto (qualquer um pode ve-la no codigo
--   da pagina). Por isso:
--     1. as tabelas tem RLS ligado e NENHUMA politica: com a chave publica,
--        ninguem le nem altera nada direto;
--     2. o site so consegue chamar as funcoes deste arquivo, e TODA funcao
--        exige o token secreto do convite (o que vai no link);
--     3. quem le as amostras e o seu computador, com a chave SECRETA, pelo
--        scripts/importar_coleta_web.py. A chave secreta nunca vai no site.
--
--   Nao existe nome, email nem foto aqui: so o codigo do participante
--   (P02, P03...) e as coordenadas dos 21 pontos da mao.
-- =====================================================================

create table if not exists public.convites (
    token        text primary key check (length(token) >= 20),
    participante text not null unique check (participante ~ '^[A-Z0-9_]{1,20}$'),
    criado_em    timestamptz not null default now(),
    consentiu_em timestamptz,
    ativo        boolean not null default true
);

create table if not exists public.sessoes (
    participante text not null references public.convites (participante) on delete cascade,
    sessao       text not null check (sessao ~ '^S[0-9]{2}$'),
    inicio       timestamptz not null default now(),
    condicoes    jsonb not null default '{}'::jsonb,
    primary key (participante, sessao)
);

create table if not exists public.amostras (
    id           bigint generated always as identity primary key,
    participante text not null,
    sessao       text not null,
    classe       text not null check (classe ~ '^[A-Z0-9_]{1,30}$'),
    criado_em    timestamptz not null default now(),
    dados        jsonb not null,             -- landmarks, world_landmarks, hand_present
    meta         jsonb not null default '{}'::jsonb,
    foreign key (participante, sessao)
        references public.sessoes (participante, sessao) on delete cascade
);
create index if not exists amostras_participante_idx
    on public.amostras (participante, sessao, classe);

alter table public.convites enable row level security;
alter table public.sessoes  enable row level security;
alter table public.amostras enable row level security;
revoke all on table public.convites, public.sessoes, public.amostras from anon, authenticated;


-- ---------------------------------------------------------------------
-- Funcoes chamadas pelo site. Todas comecam validando o convite.
-- ---------------------------------------------------------------------

-- Valida o token e devolve o convite. Uso interno (nao exposto ao site).
create or replace function public._convite(p_token text, p_exige_consentimento boolean)
returns public.convites
language plpgsql stable security definer set search_path = public
as $$
declare
    c public.convites;
begin
    select * into c from public.convites where token = p_token and ativo;
    if not found then
        raise exception 'convite_invalido';
    end if;
    if p_exige_consentimento and c.consentiu_em is null then
        raise exception 'sem_consentimento';
    end if;
    return c;
end;
$$;


-- O que o site precisa saber ao abrir o link.
create or replace function public.abrir_convite(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
    c public.convites := public._convite(p_token, false);
begin
    return jsonb_build_object(
        'participante', c.participante,
        'consentiu', c.consentiu_em is not null,
        'sessoes', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'sessao', s.sessao, 'inicio', s.inicio, 'condicoes', s.condicoes)
                   order by s.sessao)
            from public.sessoes s where s.participante = c.participante), '[]'::jsonb),
        -- chave "S01/LETRA_A" -> quantas amostras
        'contagem', coalesce((
            select jsonb_object_agg(t.chave, t.n)
            from (select a.sessao || '/' || a.classe as chave, count(*) as n
                  from public.amostras a where a.participante = c.participante
                  group by a.sessao, a.classe) t), '{}'::jsonb)
    );
end;
$$;


create or replace function public.registrar_consentimento(p_token text)
returns void
language plpgsql volatile security definer set search_path = public
as $$
declare
    c public.convites := public._convite(p_token, false);
begin
    update public.convites set consentiu_em = coalesce(consentiu_em, now())
    where token = c.token;
end;
$$;


-- Cria a proxima sessao (S01, S02...) com as condicoes da gravacao.
create or replace function public.nova_sessao(p_token text, p_condicoes jsonb)
returns text
language plpgsql volatile security definer set search_path = public
as $$
declare
    c public.convites := public._convite(p_token, true);
    numero int;
    codigo text;
    condicoes jsonb;
begin
    select coalesce(max(substring(sessao from 2)::int), 0) + 1 into numero
    from public.sessoes where participante = c.participante;
    if numero > 20 then
        raise exception 'limite_atingido';
    end if;
    codigo := 'S' || lpad(numero::text, 2, '0');

    -- So as tres condicoes do protocolo, com valores conhecidos.
    condicoes := jsonb_build_object(
        'iluminacao', case when p_condicoes->>'iluminacao' in ('natural', 'artificial', 'fraca')
                           then p_condicoes->>'iluminacao' else 'nao_informado' end,
        'fundo',      case when p_condicoes->>'fundo' in ('liso', 'baguncado')
                           then p_condicoes->>'fundo' else 'nao_informado' end,
        'distancia',  case when p_condicoes->>'distancia' in ('perto', 'medio', 'longe')
                           then p_condicoes->>'distancia' else 'nao_informado' end);

    insert into public.sessoes (participante, sessao, condicoes)
    values (c.participante, codigo, condicoes);
    return codigo;
end;
$$;


-- Guarda uma amostra (uma execucao de uma letra). Devolve o id.
create or replace function public.enviar_amostra(
    p_token text, p_sessao text, p_classe text, p_dados jsonb, p_meta jsonb)
returns bigint
language plpgsql volatile security definer set search_path = public
as $$
declare
    c public.convites := public._convite(p_token, true);
    quadros int;
    novo_id bigint;
begin
    if not exists (select 1 from public.sessoes
                   where participante = c.participante and sessao = p_sessao) then
        raise exception 'sessao_invalida';
    end if;
    if p_classe !~ '^[A-Z0-9_]{1,30}$'
       or jsonb_typeof(p_dados->'hand_present') <> 'array'
       or jsonb_typeof(p_dados->'landmarks') <> 'array'
       or jsonb_typeof(p_dados->'world_landmarks') <> 'array'
       or octet_length(p_dados::text) > 300000
       or octet_length(coalesce(p_meta, '{}'::jsonb)::text) > 4000 then
        raise exception 'amostra_invalida';
    end if;
    quadros := jsonb_array_length(p_dados->'hand_present');
    if quadros < 5 or quadros > 120
       or jsonb_array_length(p_dados->'landmarks') <> quadros
       or jsonb_array_length(p_dados->'world_landmarks') <> quadros then
        raise exception 'amostra_invalida';
    end if;
    if (select count(*) from public.amostras where participante = c.participante) >= 5000 then
        raise exception 'limite_atingido';
    end if;

    insert into public.amostras (participante, sessao, classe, dados, meta)
    values (c.participante, p_sessao, p_classe, p_dados, coalesce(p_meta, '{}'::jsonb))
    returning id into novo_id;
    return novo_id;
end;
$$;


-- Desfaz uma amostra (a pessoa so apaga as proprias).
create or replace function public.apagar_amostra(p_token text, p_id bigint)
returns boolean
language plpgsql volatile security definer set search_path = public
as $$
declare
    c public.convites := public._convite(p_token, false);
begin
    delete from public.amostras where id = p_id and participante = c.participante;
    return found;
end;
$$;


-- Direito de sair do estudo: apaga tudo da pessoa e o consentimento.
create or replace function public.apagar_meus_dados(p_token text)
returns integer
language plpgsql volatile security definer set search_path = public
as $$
declare
    c public.convites := public._convite(p_token, false);
    apagadas int;
begin
    select count(*) into apagadas from public.amostras where participante = c.participante;
    delete from public.sessoes where participante = c.participante;   -- leva as amostras junto
    update public.convites set consentiu_em = null where token = c.token;
    return apagadas;
end;
$$;


-- Por padrao o Postgres deixa qualquer um executar funcoes: fecha tudo e
-- libera so as que o site usa.
revoke all on function public._convite(text, boolean) from public, anon, authenticated;
revoke all on function public.abrir_convite(text) from public;
revoke all on function public.registrar_consentimento(text) from public;
revoke all on function public.nova_sessao(text, jsonb) from public;
revoke all on function public.enviar_amostra(text, text, text, jsonb, jsonb) from public;
revoke all on function public.apagar_amostra(text, bigint) from public;
revoke all on function public.apagar_meus_dados(text) from public;

grant execute on function public.abrir_convite(text) to anon, authenticated;
grant execute on function public.registrar_consentimento(text) to anon, authenticated;
grant execute on function public.nova_sessao(text, jsonb) to anon, authenticated;
grant execute on function public.enviar_amostra(text, text, text, jsonb, jsonb) to anon, authenticated;
grant execute on function public.apagar_amostra(text, bigint) to anon, authenticated;
grant execute on function public.apagar_meus_dados(text) to anon, authenticated;
