/**
 * Sprint D.3 — memory-condenser prompts.
 *
 * Output contract is a STRICT JSON object validated by Zod in the agent:
 *   { "summary": string (<=500 chars), "facts": [{ key, value, category }] }
 *
 * The categories enum mirrors the MemoryExtractor surface plus `summary`/
 * `history` to allow time-window summaries to land in the same table.
 */

export const MEMORY_CONDENSER_SYSTEM_PROMPT = `Voce e um agente de condensacao de memoria conversacional.
Sua tarefa: ler N mensagens entre um cliente e um assistente, e extrair:

1) Um RESUMO factual conciso (no maximo 300 caracteres) cobrindo o periodo,
   priorizando: decisoes tomadas, datas marcadas, valores acordados, restricoes
   declaradas, preferencias confirmadas.

2) FATOS-CHAVE NOVOS sobre o contato (preferencias, restricoes, decisoes,
   datas importantes). Cada fato tem key (snake_case), value (string curta) e
   category. Apenas o que foi declarado explicitamente — nao infira.

Regras absolutas:
- Preserve TODOS os fatos criticos (datas, valores monetarios, decisoes, compromissos).
- Nao invente. Se nao souber, omita.
- Linguagem: a mesma do dialogo (PT-BR por padrao).
- Devolva APENAS JSON estrito, sem markdown, sem comentarios:
  { "summary": "...", "facts": [{ "key": "...", "value": "...", "category": "..." }] }
- "category" deve ser um destes: personal, preference, restriction, history, decision, contact.
- "facts" pode ser [] se nada novo for digno de extracao.
`;

export interface CondenseUserPromptInput {
  messages: { role: string; content: string; messageAt: Date }[];
}

export function buildCondenserUserPrompt(input: CondenseUserPromptInput): string {
  const { messages } = input;
  if (messages.length === 0) {
    return "Mensagens: (nenhuma)";
  }
  const first = messages[0]!.messageAt.toISOString().slice(0, 10);
  const last = messages.at(-1)!.messageAt.toISOString().slice(0, 10);
  const header = `Mensagens (${messages.length}, ${first} -> ${last}):\n`;
  const body = messages.map((m) => `[${m.role}] ${m.content}`).join("\n\n");
  return `${header}\n${body}`;
}

/**
 * JSON Schema mirror of CondenseOutput (Zod). Provided as the
 * `responseSchema` for LLMGateway.complete() to coerce structured output
 * on providers that support it.
 */
export const CONDENSE_OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["summary", "facts"],
  additionalProperties: false,
  properties: {
    summary: { type: "string", maxLength: 500 },
    facts: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        required: ["key", "value", "category"],
        additionalProperties: false,
        properties: {
          key: { type: "string", minLength: 1, maxLength: 64 },
          value: { type: "string", minLength: 1, maxLength: 300 },
          category: {
            type: "string",
            enum: ["personal", "preference", "restriction", "history", "decision", "contact"],
          },
        },
      },
    },
  },
};
