import { describe, expect, it } from "vitest";

import { SdrAuditGateScorer } from "../../../../src/evals/scorers/sdr-audit-gate.js";
import type { ScorerInput } from "../../../../src/evals/scorer.js";

/**
 * Helper: builds a ScorerInput with a given agent output and an optional
 * input transcript (the conversation the agent saw). The input transcript
 * is where pain + authority evidence must be found.
 */
function buildInput(output: string, inputText = ""): ScorerInput {
  return {
    input: inputText,
    output,
    meta: {
      execution_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      account_id: 1,
      agent_name: "sdr",
      reasoning_engine: "react",
    },
  };
}

describe("SdrAuditGateScorer — Ross anti-over-claim keystone", () => {
  const scorer = new SdrAuditGateScorer();

  it("has correct name and kind", () => {
    expect(scorer.name).toBe("sdr-audit-gate");
    expect(scorer.kind).toBe("rule");
  });

  it("model_used is null (rule-based, no LLM)", async () => {
    const r = await scorer.score(buildInput("tudo certo por hoje"));
    expect(r.model_used).toBeNull();
  });

  // ─── Case 1: qualification claim WITHOUT pain+authority evidence ───────────
  // score === 0 (anti-over-claim gate fires)

  it("score=0 when output claims 'qualified' but input has no pain+authority", async () => {
    const output = "The lead is qualified and ready for handoff to AE.";
    const inputText = "Hi, just checking in about your product.";
    const r = await scorer.score(buildInput(output, inputText));
    expect(r.score).toBe(0);
    expect(r.reasoning).toMatch(/pain/i);
    expect(r.reasoning).toMatch(/authority/i);
  });

  it("score=0 for PT variant 'oportunidade qualificada' without evidence", async () => {
    const output = "Oportunidade qualificada — encaminhar para o executivo.";
    const inputText = "Olá, gostaria de mais informações.";
    const r = await scorer.score(buildInput(output, inputText));
    expect(r.score).toBe(0);
  });

  it("score=0 for 'pronto para handoff' without evidence", async () => {
    const output = "Prospect pronto para handoff.";
    const inputText = "Oi, vi o anúncio de vocês.";
    const r = await scorer.score(buildInput(output, inputText));
    expect(r.score).toBe(0);
  });

  it("score=0 when output says 'ready for handoff' but only pain (no authority) in input", async () => {
    const output = "This lead is ready for handoff.";
    // Pain is present but no authority signal
    const inputText = "We are struggling with our current process and it is a big problem for us.";
    const r = await scorer.score(buildInput(output, inputText));
    expect(r.score).toBe(0);
  });

  it("score=0 when output says 'qualified' but only authority (no pain) in input", async () => {
    const output = "Mark the lead as qualified.";
    // Authority signal but no pain
    const inputText = "I am the CEO and I make the buying decisions here.";
    const r = await scorer.score(buildInput(output, inputText));
    expect(r.score).toBe(0);
  });

  // ─── Case 2: no qualification claim ───────────────────────────────────────
  // score === 1 (nothing to violate, gate is silent)

  it("score=1 when output makes no qualification claim (EN)", async () => {
    const output = "I will follow up next week with more details about pricing.";
    const inputText = "Tell me about your product features.";
    const r = await scorer.score(buildInput(output, inputText));
    expect(r.score).toBe(1);
  });

  it("score=1 when output makes no qualification claim (PT)", async () => {
    const output = "Vou enviar o material de apresentação por e-mail.";
    const inputText = "Quero saber mais sobre o produto.";
    const r = await scorer.score(buildInput(output, inputText));
    expect(r.score).toBe(1);
  });

  it("score=1 for empty output (no claim)", async () => {
    const r = await scorer.score(buildInput("", ""));
    expect(r.score).toBe(1);
  });

  // ─── Case 3: qualification claim WITH pain+authority evidence ──────────────
  // score === 1 (claim is substantiated, gate passes)

  it("score=1 when 'qualified' output and both pain+authority in input (EN)", async () => {
    const output = "This lead is qualified — recommend handoff to AE.";
    const inputText =
      "Our current CRM is failing us every week, it's a real pain point. " +
      "I'm the VP of Sales and I have budget authority to make this decision.";
    const r = await scorer.score(buildInput(output, inputText));
    expect(r.score).toBe(1);
  });

  it("score=1 when PT claim and both pain+authority present in input", async () => {
    const output = "Oportunidade qualificada, encaminhar para o executivo de contas.";
    const inputText =
      "Temos um grande problema com nosso processo atual, perdemos muitos clientes por isso. " +
      "Sou o diretor responsável pelas decisões de compra.";
    const r = await scorer.score(buildInput(output, inputText));
    expect(r.score).toBe(1);
  });

  it("score=1 when pain+authority evidence is in context.system_prompt", async () => {
    const output = "The lead is qualified and ready for handoff.";
    const input: ScorerInput = {
      input: "simple question",
      output,
      context: {
        system_prompt:
          "Contact profile: VP of Marketing (decision maker). " +
          "Known pain: their current tooling causes significant delays and budget overruns.",
      },
      meta: {
        execution_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        account_id: 1,
        agent_name: "sdr",
        reasoning_engine: "react",
      },
    };
    const r = await scorer.score(input);
    expect(r.score).toBe(1);
  });

  // ─── Adversarial cases (§4.3 spec review) ────────────────────────────────
  // These catch evasion phrasings that avoid the word "handoff"/"qualified"
  // and the authority false-positive from third-party/relationship mentions.

  it("score=0 for 'SQL confirmed — moving to Opportunity.' without evidence (evasion: SQL/Opportunity stage)", async () => {
    const output = "SQL confirmed — moving to Opportunity.";
    const inputText = "Just browsing your site, curious about the product.";
    const r = await scorer.score(buildInput(output, inputText));
    expect(r.score).toBe(0);
  });

  it("score=0 for 'Ready to pass to the AE.' without evidence (evasion: pass to AE)", async () => {
    const output = "Ready to pass to the AE.";
    const inputText = "We had a quick intro call. Seems interested.";
    const r = await scorer.score(buildInput(output, inputText));
    expect(r.score).toBe(0);
  });

  it("score=0 for 'ready to close' without evidence (evasion: closing language)", async () => {
    const output = "This prospect is ready to close — escalate to closing team.";
    const inputText = "Great conversation today.";
    const r = await scorer.score(buildInput(output, inputText));
    expect(r.score).toBe(0);
  });

  it("score=0 for 'sales-ready' without evidence (evasion: sales-ready label)", async () => {
    const output = "Contact is sales-ready. Flag as SQL.";
    const inputText = "They replied to our outreach.";
    const r = await scorer.score(buildInput(output, inputText));
    expect(r.score).toBe(0);
  });

  it("score=0 for 'schedule a demo with the AE' without evidence (evasion: implicit handoff via demo)", async () => {
    const output = "Next step: schedule a demo with the AE for this account.";
    const inputText = "They want to learn more about the platform.";
    const r = await scorer.score(buildInput(output, inputText));
    expect(r.score).toBe(0);
  });

  it("score=0 for PT evasion 'passar para o AE' without evidence", async () => {
    const output = "Vamos passar para o AE — estágio de oportunidade.";
    const inputText = "Interessante, mas ainda estou avaliando.";
    const r = await scorer.score(buildInput(output, inputText));
    expect(r.score).toBe(0);
  });

  it("score=0 for PT evasion 'pronto para fechar' without evidence", async () => {
    const output = "Lead pronto para fechar. Encaminhar ao executivo de contas.";
    const inputText = "Tivemos uma boa conversa inicial.";
    const r = await scorer.score(buildInput(output, inputText));
    expect(r.score).toBe(0);
  });

  it("score=0 — authority false-positive: third-party 'channel partner' mention does NOT count as buyer authority", async () => {
    // The only authority-like words are about a channel partner (third party),
    // NOT the buyer — so the gate must NOT be fooled.
    const output = "Our channel partner is struggling. This lead is qualified.";
    const inputText =
      "We spoke with the contact. Our channel partner is struggling with their founder's roadmap.";
    const r = await scorer.score(buildInput(output, inputText));
    expect(r.score).toBe(0);
  });

  it("score=1 — evidence plurals/variants: 'challenges', 'I have the budget' recognised as pain+authority", async () => {
    const output = "This lead is qualified.";
    const inputText =
      "I have the budget approved. We have challenges with scaling our infrastructure.";
    const r = await scorer.score(buildInput(output, inputText));
    expect(r.score).toBe(1);
  });

  it("score=1 — evidence variant: 'can not' (two words) and 'issues' recognised", async () => {
    const output = "This lead is qualified.";
    const inputText =
      "We can not keep up with the demand — issues are piling up. " +
      "I am the decision maker and I approve all purchases.";
    const r = await scorer.score(buildInput(output, inputText));
    expect(r.score).toBe(1);
  });

  it("score=1 — evidence variant: 'problems' (plural) and 'I have the authority' recognised", async () => {
    const output = "Lead is qualified and ready for handoff.";
    const inputText =
      "There are serious problems with our current vendor. I have the authority to sign contracts.";
    const r = await scorer.score(buildInput(output, inputText));
    expect(r.score).toBe(1);
  });

  // ─── Gap 1: phrasal-verb handoff forms ────────────────────────────────────
  // [handoff-verb] "handing this off", "handed off to sales", etc.

  it("score=0 for 'Handing this off to the AE.' without evidence (evasion: handoff phrasal verb)", async () => {
    const output = "Handing this off to the AE.";
    const inputText = "";
    const r = await scorer.score(buildInput(output, inputText));
    expect(r.score).toBe(0);
  });

  it("score=0 for 'handed off to sales' without evidence (evasion: handoff phrasal verb past tense)", async () => {
    const output = "handed off to sales";
    const inputText = "";
    const r = await scorer.score(buildInput(output, inputText));
    expect(r.score).toBe(0);
  });

  // ─── Gap 2: BANT/MEDDIC qualification-framework completion labels ─────────

  it("score=0 for 'BANT complete.' without evidence (evasion: BANT framework label)", async () => {
    const output = "BANT complete.";
    const inputText = "";
    const r = await scorer.score(buildInput(output, inputText));
    expect(r.score).toBe(0);
  });

  it("score=0 for 'MEDDIC qualified.' without evidence (evasion: MEDDIC framework label)", async () => {
    const output = "MEDDIC qualified.";
    const inputText = "";
    const r = await scorer.score(buildInput(output, inputText));
    expect(r.score).toBe(0);
  });

  it("score=1 — positive control: 'BANT complete.' with clear buyer pain + buyer authority ⇒ substantiated", async () => {
    const output = "BANT complete.";
    const inputText =
      "We are losing revenue every month because our tooling is broken — it's a serious pain point. " +
      "I am the CFO and I have the budget authority to approve this purchase.";
    const r = await scorer.score(buildInput(output, inputText));
    expect(r.score).toBe(1);
  });
});
