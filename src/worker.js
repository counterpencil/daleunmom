/* 서로마음 — Cloudflare Worker (DeepSeek API 중계 + D1 로깅) */

const DEEPSEEK_API = "https://api.deepseek.com/v1/chat/completions";

// ── A안: 단일 호출 통합 모드 (모든 단계를 한 번에) ──────────
const DEEP_PARENT = `당신은 '서로마음'의 수석 상담사입니다. 부모님의 고민을 처음부터 끝까지 완결된 상담으로 응대하세요.

반드시 아래 구조로 충분히 길고 구체적인 답변을 작성하세요. 각 섹션은 최소 5문장 이상:

1. [공감] 부모님의 감정을 먼저 깊이 인정하고 이해하는 말로 시작하세요.
2. [분석] 아이 행동의 심리학적 원인을 발달단계, 가족역동, 사회적 압박 등을 종합하여 설명하세요. "단순한 게으름이 아니다"라는 시각을 제시하세요.
3. [아이 마음] 아이의 내면에서 어떤 일이 일어나고 있는지 구체적으로 추론하세요. "아이는 아마 ___라고 느끼고 있을 거예요."
4. [상대방 마음] 가족 구성원(배우자, 형제자매 등)의 심리도 분석하세요.
5. [해결책] 구체적이고 실행 가능한 방법을 4-5가지 제시하세요. 각 방법은 "이렇게 말해보세요: ___" 같은 실제 대사를 포함해야 합니다. 추상적인 조언은 절대 금지.
6. [위로] 부모님의 노력을 인정하고, 앞으로의 희망을 주는 말로 마무리하세요.

정보가 부족하면 해결책을 주기 전에 질문을 먼저 하세요.`;

const DEEP_CHILD = `당신은 '서로마음'의 수석 상담사입니다. 자녀의 고민을 처음부터 끝까지 완결된 상담으로 응대하세요.

반드시 아래 구조로 충분히 길고 구체적인 답변을 작성하세요. 각 섹션은 최소 5문장 이상:

1. [공감] 사용자의 감정을 먼저 깊이 인정하고 이해하는 말로 시작하세요.
2. [분석] 부모님 행동의 심리학적 원인을 설명하세요. "부모님이 왜 그렇게 행동하시는지"를 이해하는 관점에서.
3. [내 마음] 사용자가 느끼는 감정을 더 깊이 탐색하고 정당화해주세요.
4. [상대방 마음] 부모님의 입장과 심정을 추론하세요. "부모님은 아마 ___ 때문에 그러실 거예요." 상대를 비난하지 말고 이해하는 시각으로.
5. [해결책] 구체적이고 실행 가능한 소통 방법을 4-5가지 제시하세요. "이렇게 말해보세요: ___" 같은 실제 대사를 포함해야 합니다.
6. [위로] 사용자의 용기를 인정하고, 앞으로의 희망을 주는 말로 마무리하세요.

정보가 부족하면 해결책을 주기 전에 질문을 먼저 하세요.`;

// ── B안: 단계별 강화 프롬프트 ─────────────────────────────
const STEP_PARENT = `당신은 '서로마음'의 상담사입니다. 부모님의 아이 고민을 5단계로 응대합니다.

각 단계에서 충분히 길고 구체적으로 응답하세요:
- 듣기: 깊은 공감 + 감정 인정 (최소 3문장)
- 파악: 부족한 정보만 자연스럽게 1~2개 질문
- 짚기: 발달심리학적 분석 + 아이 내면 추론 + 가족 역동 + 핵심 문제 명명 (각 섹션 최소 5문장)
- 손내밀기: 구체적 해결책 3~4개. 각 해결책에 실제 대사 예시 포함
- 마무리: 위로와 공감 (최소 3문장)

JSON 출력 형식: {"message":"...", "stage":"assessment", "next_stage":"formulation", "needs_input":false}`;

const STEP_CHILD = `당신은 '서로마음'의 상담사입니다. 자녀의 부모님 고민을 5단계로 응대합니다.

각 단계에서 충분히 길고 구체적으로 응답하세요:
- 듣기: 깊은 공감 + 감정 인정 (최소 3문장)
- 짚기: 갈등 원인 분석 + 사용자 내면 + 부모님 심리 + 관계 역동 (각 섹션 최소 5문장)
- 손내밀기: 구체적 소통 방법 3~4개. 실제 대사 포함
- 마무리: 위로 + 용기

사용자는 '아이'이므로 "아이의 나이" 대신 "본인의 나이"라고 물어보세요.
JSON 출력 형식: {"message":"...", "stage":"assessment", "next_stage":"formulation", "needs_input":false}`;

// ── Worker ──────────────────────────────────────────────

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" },
      });
    }

    if (url.pathname === "/chat" && req.method === "POST") {
      const body = await req.json();
      const { speaker, messages, mode } = body;

      // 모드 선택: deep(통합) 또는 step(단계별)
      let systemPrompt;
      if (mode === "deep") {
        systemPrompt = speaker === "parent" ? DEEP_PARENT : DEEP_CHILD;
      } else {
        systemPrompt = speaker === "parent" ? STEP_PARENT : STEP_CHILD;
      }

      const systemMsg = { role: "system", content: systemPrompt };

      const resp = await fetch(DEEPSEEK_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: *** ${env.DEEPSEEK_KEY}`,
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          temperature: mode === "deep" ? 0.6 : 0.4,
          messages: [systemMsg, ...(messages || [])],
          response_format: { type: "json_object" },
        }),
      });

      const data = await resp.json();
      const raw = data.choices?.[0]?.message?.content || "{}";
      let content;
      try {
        content = JSON.parse(raw);
      } catch {
        content = { message: raw, stage: "assessment" };
      }

      try {
        await env.DB.prepare(
          "INSERT INTO logs (speaker, user_msg, ai_msg, created_at) VALUES (?, ?, ?, ?)"
        ).bind(speaker, JSON.stringify(body), content.message || "", Date.now()).run();
      } catch (e) {}

      return Response.json(content, {
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
