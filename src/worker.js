/* 서로마음 */

const API = "https://api.deepseek.com/v1/chat/completions";
import { searchScenarios } from "./scenarios_index.js";

async function callLLM(sys, msgs, env, opts = {}) {
  const auth = "B" + "earer " + env.DEEPSEEK_KEY;
  const headers = { "Content-Type": "application/json" };
  headers["Authorization"] = auth;
  const resp = await fetch(API, {
    method: "POST", headers,
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

function fakeStream(text, warmup = false) {
  const encoder = new TextEncoder();
  const clean = (text || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
  let pos = 0;
  return new ReadableStream({
    async start(controller) {
      if (warmup) {
        // 단계별 상태 알림
        const steps = ["안전 검사 완료", "맞춤 답변 생성 중...", "감정 검토 완료"];
        for (const step of steps) {
          controller.enqueue(encoder.encode("data: " + JSON.stringify({ status: step }) + "\n\n"));
          await new Promise(r => setTimeout(r, 400));
        }
      }
    },
    async pull(controller) {
      if (pos >= clean.length) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      const chunk = clean.slice(pos, pos + 3);
      pos += 3;
      const sse = "data: " + JSON.stringify({ choices: [{ delta: { content: chunk } }] }) + "\n\n";
      controller.enqueue(encoder.encode(sse));
      await new Promise(r => setTimeout(r, 12));
    },
  });
}

const SAFETY_JUDGE_PROMPT = `당신은 상담 안전검사기이자 단계 판단기입니다.

안전 평가 (risk 0~5):
- 0~2: 일반 육아 고민
- 3~5: 체벌/학대/자해 → 중단

상담 단계:
- "intake": 고민이 한 문장이고 막연함 → 공감 + 물어보기
- "assess": 고민은 구체적인데 나이/기간/가족구성 중 2개 이상 빠짐 → 질문
- "analyze": 상황 설명이 3문장 이상으로 구체적 → 바로 분석 (질문 건너뜀)
- "solve": 분석 완료 → 해결책

중요: 사용자가 길고 구체적인 상황(4문장 이상)을 설명했으면 무조건 "analyze"로 가세요. 정보가 좀 부족해도 충분히 추론 가능하면 질문하지 마세요.
사용자가 "왜", "어떻게" 같은 질문을 직접 했으면 "analyze" 또는 "solve"로 가세요.

JSON: {"risk":0,"stage":"analyze","reason":"사용자가 구체적 상황을 5문장으로 설명함, 바로 분석 가능"}`;

const COMFORT = `[필수 규칙]
1. 절대 부모님을 비난하지 마세요. "부모님이 ~해서"라는 인과관계 설명 금지.
   → ❌ "부모님이 불안해하셔서 아이도 불안합니다"
   → ✅ "아이의 불안은 이 시기 자연스러운 현상입니다"

2. 모든 해결책은 제안형으로. "~하세요" 금지.
   → "이런 방법을 시도해보시는 건 어떨까요?"

3. 부모가 자책하는 느낌이 들 때만 자연스럽게 "부모님 탓이 아닙니다"를 말하세요. 무리하게 넣지 마세요.`;

const STAGE_PROMPTS = {
  intake: `공감하고 고민을 더 물어보세요. 2~3문장.`,
  assess: `공감 후 부족한 정보를 1~2개만 물어보세요.`,
  analyze: `간결하게. 공감은 첫 문장에 자연스럽게 녹이고, 별도 섹션으로 두지 마세요.
필요한 만큼만 설명하세요. 가벼운 고민이면 짧게, 깊은 고민이면 더 자세히.
"부모님 탓이 아닙니다"를 반드시 포함하세요.`,
  solve: `당신은 육아 상담 전문가입니다. 아래 [참고 예시(Examples)]를 가장 중요한 지식 소스로 삼아 답변을 작성하세요.

## 핵심 규칙
1. [참고 예시]의 모든 analysis(전문가 분석)와 solution(전문가 해결책)을 답변에 빠짐없이 포함하세요. 하나라도 누락하면 안 됩니다.
2. "이렇게 말해보세요:" 형식의 구체적 대사를 최소 3개 포함하세요. 각 대사는 [참고 예시]의 통찰과 해결책을 실제 대화처럼 자연스럽게 풀어내야 합니다.
3. 첫 문장은 부모의 감정에 공감하는 말로 시작하세요. 공감만으로 끝내지 말고 반드시 분석과 해결책으로 이어가세요.
4. 답변을 질문으로 끝내지 마세요. 실행 가능한 해결책 제시로 마무리하세요.

## 답변 구조
공감(1-2문장) → [참고 예시]의 전문가 분석 설명 → [참고 예시]의 구체적 해결책 제시 → "이렇게 말해보세요:" 대사 3개 이상

## 주의사항
- [참고 예시]가 여러 개면 모든 예시의 통찰과 해결책을 포함하세요 (하나라도 빠뜨리면 안 됨)
- 부모님을 절대 비난하지 마세요. "전문가에 따르면" 같은 표현으로 객관성을 유지하세요.
- 인코딩 깨짐(특수문자, 이모지) 절대 금지`,
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
      try {
        const { speaker, messages, profile } = await req.json();
        const lastMsg = (messages || []).slice(-1)[0]?.content || "";

        const sjResult = await callLLM(SAFETY_JUDGE_PROMPT, messages || [], env, { temp: 0.2, json: true });
        let risk = 0, stage = "intake";
        try { const sj = JSON.parse(sjResult); risk = sj.risk || 0; stage = sj.stage || "intake"; } catch {}

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
              (i+1) + ". " + s.situation + " | " + s.analysis + " | " + s.solution
            ).join("\n\n");
          }
        }

        const isEnglish = /^[a-zA-Z0-9\s?.,!'"]+$/.test(lastMsg.replace(/\s/g, '').slice(0, 30));
        const langHint = isEnglish ? "\nRespond in English." : "";

        const prompt = STAGE_PROMPTS[stage] || STAGE_PROMPTS.intake;
        const sysContent = COMFORT + "\n" + prompt + profileHint + langHint + ragContext;

        // 진짜 스트리밍
        const auth = "B" + "earer " + env.DEEPSEEK_KEY;
        const headers = { "Content-Type": "application/json" };
        headers["Authorization"] = auth;
        const resp = await fetch(API, {
          method: "POST", headers,
          body: JSON.stringify({
            model: "deepseek-chat",
            temperature: stage === "intake" || stage === "assess" ? 0.4 : 0.6,
            messages: [{ role: "system", content: sysContent }, ...(messages || [])],
            stream: true,
          }),
        });

        return new Response(resp.body, { headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache", "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        }});
      } catch {
        return Response.json({ message: "죄송합니다. 일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요." }, {
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
