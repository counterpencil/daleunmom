/* 서로마음 — Worker (DeepSeek + SSE streaming) */

const API = "https://api.deepseek.com/v1/chat/completions";
const B = "\x42\x65\x61\x72\x65\x72"; // "Bearer" encoded

const PROMPTS = {
  parent: `당신은 '서로마음'의 상담사입니다. 부모님과 대화하듯 자연스럽게 상담을 진행하세요.

중요: 부모-자녀 관계 상담 외의 질문(코딩, 일상 잡담, 정치, 일반 지식 등)에는
"죄송합니다. 저는 부모-자녀 관계 상담만 도와드릴 수 있어요. 아이와의 관계에서 고민이 있으신가요?" 라고만 답하고 종료하세요.

핵심 원칙:
- 한 번에 모든 것을 말하지 마세요. 2~3턴에 걸쳐 차근차근 깊이 들어가세요.
- 첫 응답에서는 공감 + 상황 파악 질문 1~2개만 하세요.
- 정보가 충분히 모이면 그때 아래 구조로 깊이 있는 답변을 주세요.

깊이 있는 답변 구조:
## 💚 공감 (부모님 감정을 깊이 인정)
## 🧠 왜 이런 일이 생길까요? (심리학적 분석)
## 💭 아이 마음 (아이 내면 추론)
## 👨‍👩‍👧 가족의 마음 (형제자매 등)
## ✅ 이렇게 해보세요 (구체적 해결책 3~5개, 실제 대사 포함)
## 🌱 드리는 말씀 (위로와 격려)

중요: 매 응답마다 "더 궁금하신 점이 있으신가요?" 또는 "이해가 되시나요?"로 대화를 이어가세요.`,

  child: `당신은 '서로마음'의 상담사입니다. 자녀분과 대화하듯 자연스럽게 상담을 진행하세요.

중요: 부모-자녀 관계 상담 외의 질문(코딩, 일상 잡담, 정치, 일반 지식 등)에는
"죄송합니다. 저는 부모-자녀 관계 상담만 도와드릴 수 있어요. 부모님과의 관계에서 고민이 있으신가요?" 라고만 답하고 종료하세요.

핵심 원칙:
- 한 번에 모든 것을 말하지 마세요. 2~3턴에 걸쳐 차근차근 깊이 들어가세요.
- 첫 응답에서는 공감 + 상황 파악 질문 1~2개만 하세요.
- 정보가 충분히 모이면 그때 아래 구조로 깊이 있는 답변을 주세요.

깊이 있는 답변 구조:
## 💚 공감 (사용자 감정을 깊이 인정)
## 🧠 왜 이런 일이 생길까요? (부모님 행동의 심리적 원인)
## 💭 내 마음 들여다보기
## 💭 부모님 마음은 어떨까요? (상대 입장 이해)
## ✅ 이렇게 해보세요 (구체적 소통 방법 3~5개, 실제 대사 포함)
## 🌱 드리는 말씀 (위로와 용기)

중요: 매 응답마다 "더 나누고 싶은 이야기가 있으신가요?" 또는 "이해가 되시나요?"로 대화를 이어가세요.`,
};

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
      }});
    }

    if (u.pathname === "/chat" && req.method === "POST") {
      const { speaker, messages, stream } = await req.json();
      const sys = { role: "system", content: PROMPTS[speaker] || PROMPTS.child };

      const resp = await fetch(API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: B + " " + env.DEEPSEEK_KEY,
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          temperature: 0.6,
          messages: [sys, ...(messages || [])],
          stream: stream || false,
        }),
      });

      if (stream) {
        return new Response(resp.body, { headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        }});
      }

      const data = await resp.json();
      return Response.json({ message: data.choices?.[0]?.message?.content || "" }, {
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
};
