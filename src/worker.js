/* 서로마음 — Worker */

const API = "https://api.deepseek.com/v1/chat/completions";
import { searchScenarios } from "./scenarios_index.js";

async function callLLM(sys, msgs, env, opts = {}) {
  const auth = "B" + "earer " + env.DEEPSEEK_KEY;
  const headers = { "Content-Type": "application/json" };
  headers["Authorization"] = auth;
  const resp = await fetch(API, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "deepseek-chat",
      temperature: opts.temp || 0.4,
      messages: [{ role: "system", content: sys }, ...(msgs || [])],
      response_format: opts.json ? { type: "json_object" } : undefined,
    }),
  });
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "";
}

function fakeStream(text) {
  const encoder = new TextEncoder();
  let pos = 0;
  const chunkSize = 3;
  return new ReadableStream({
    async pull(controller) {
      if (pos >= text.length) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      const chunk = text.slice(pos, pos + chunkSize);
      pos += chunkSize;
      const sse = "data: " + JSON.stringify({ choices: [{ delta: { content: chunk } }] }) + "\n\n";
      controller.enqueue(encoder.encode(sse));
      await new Promise(r => setTimeout(r, 15));
    },
  });
}

const SAFETY_JUDGE_PROMPT = `당신은 상담 안전검사기이자 단계 판단기입니다.

안전 평가 (risk 0~5):
- 0~2: 일반 육아 고민
- 3~5: 체벌/학대/자해 → 중단

상담 단계:
- "intake": 고민 막연 → 공감 + 물어보기
- "assess": 정보 부족 → 질문
- "analyze": 정보 충분 + 사용자가 상황을 잘 이해하지 못함 → 공감하며 설명 먼저
- "solve": 정보 충분 + 사용자가 이미 상황을 이해함 → 바로 해결책

판단 기준:
- 사용자가 "왜 이러는 걸까요?", "이해가 안 돼요" 같은 표현 → analyze
- 사용자가 "어떻게 해야 할까요?", "방법을 알려주세요" → solve
- 사용자가 구체적 행동을 묻고 자신의 감정을 잘 설명함 → solve
- 사용자가 감정에 압도되어 있고 원인을 모름 → analyze

JSON: {"risk":0,"stage":"assess","reason":"..."}`;

const SAFETY_BLOCK = "이런 고민은 전문 상담 센터(한국정신건강복지센터 1577-0199)의 도움을 받으시는 것이 좋습니다. 서로마음은 가벼운 육아 고민만 도와드릴 수 있습니다.";

const COMFORT = `[필수] 육아 경험이 있는 상담사입니다. 절대 부모님을 비난하지 마세요. "부모님 탓이 아닙니다"를 자연스럽게 포함하세요.`;

const STAGE_PROMPTS = {
  intake: `공감하고 고민을 더 물어보세요. 2~3문장.`,
  assess: `공감 후 부족한 정보를 1~2개만 물어보세요.`,
  analyze: `간결하게. 공감은 첫 문장에 자연스럽게 녹이고, 별도 섹션으로 두지 마세요.
필요한 만큼만 설명하세요. 가벼운 고민이면 짧게, 깊은 고민이면 더 자세히.
"부모님 탓이 아닙니다"를 반드시 포함하세요.`,

  solve: `당장 쓸 수 있는 구체적 대사를 먼저. 길게 설명하지 마세요.
공감은 첫 문장에만. 대사와 실천 방법에 집중하세요.
## 🗣 지금 이렇게 말해보세요 (구체적 대사 2~3개)
## ✅ 한 가지만 더`,

  close: `따뜻하게 마무리하세요. 2~3문장.`,
};

const EMOTIONAL_REVIEW_PROMPT = `당신은 응답 검토기입니다. 아래 응답에서:

1. 부모를 비난하거나 죄책감을 주는 문장을 찾아 부드럽게 수정하세요.
2. "~해야 합니다" 같은 강압적 표현을 제안형으로 바꾸세요.

⚠️ 절대 새로운 섹션이나 내용을 추가하지 마세요. 원본 구조를 그대로 유지하세요.
수정이 필요 없으면 원본을 그대로 반환하세요.
수정된 응답만 출력하세요. 설명을 붙이지 마세요.`;

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
      const { speaker, messages, profile } = await req.json();
      const lastMsg = (messages || []).slice(-1)[0]?.content || "";

      const sjResult = await callLLM(SAFETY_JUDGE_PROMPT, messages || [], env, { temp: 0.2, json: true });
      let risk = 0, stage = "intake";
      try { const sj = JSON.parse(sjResult); risk = sj.risk || 0; stage = sj.stage || "intake"; } catch {}

      if (risk >= 3) {
        return new Response(SAFETY_BLOCK, { headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        }});
      }

      let profileHint = "";
      if (profile && (profile.age || profile.gender || profile.temperament?.length)) {
        profileHint = "\n[Profile]";
        if (profile.age) profileHint += " age: " + profile.age;
        if (profile.gender) profileHint += ", " + profile.gender;
        if (profile.temperament?.length) profileHint += ", traits: " + profile.temperament.join(", ");
      }

      let ragContext = "";
      if (stage === "analyze" || stage === "solve") {
        const scenarios = searchScenarios(lastMsg);
        if (scenarios.length > 0) {
          ragContext = "\n\nExamples:\n" + scenarios.map((s, i) =>
            (i+1) + ". " + s.situation + " | Analysis: " + s.analysis + " | Solution: " + s.solution
          ).join("\n\n");
        }
      }

      const isEnglish = /^[a-zA-Z0-9\s?.,!'"]+$/.test(lastMsg.replace(/\s/g, '').slice(0, 30));
      const langHint = isEnglish ? "\nRespond in English." : "";

      const prompt = STAGE_PROMPTS[stage] || STAGE_PROMPTS.intake;
      const sysContent = COMFORT + "\n" + prompt + profileHint + langHint + ragContext;
      let responseText = await callLLM(sysContent, messages || [], env, {
        temp: stage === "intake" || stage === "assess" ? 0.4 : 0.6,
      });

      if (stage === "analyze" || stage === "solve") {
        try {
          responseText = await callLLM(EMOTIONAL_REVIEW_PROMPT, [{ role: "user", content: responseText }], env, { temp: 0.2 });
        } catch {}
      }

      const stream = fakeStream(responseText);
      return new Response(stream, { headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache", "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      }});
    }

    return new Response("Not found", { status: 404 });
  },
};
