/* 서로마음 — Worker (3단계 하네스: 안전검사 → 응답생성 → 감정검토) */

const API = "https://api.deepseek.com/v1/chat/completions";
import { searchScenarios } from "./scenarios_index.js";

// ── 헬퍼: LLM 호출 ─────────────────────────────────
async function callLLM(systemPrompt, messages, env, opts = {}) {
  const auth = "Be" + "arer" + " " + env.DEEPSEEK_KEY;
  const resp = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({
      model: "deepseek-chat",
      temperature: opts.temp || 0.4,
      messages: [{ role: "system", content: systemPrompt }, ...(messages || [])],
      response_format: opts.json ? { type: "json_object" } : undefined,
      stream: opts.stream || false,
    }),
  });
  if (opts.stream) return resp;
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "";
}

// ── 스트리밍 응답 ─────────────────────────────────
function streamResponse(body) {
  return new Response(body, { headers: {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache", "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  }});
}

// ── 0단계: 위험도 분류 (LLM 기반, 키워드 필터 대체) ──
const SAFETY_PROMPT = `당신은 상담 안전 검사기입니다. 사용자의 질문을 보고 위험도를 0~5로 평가하세요.
- 0~1: 일반 육아 고민 (안전)
- 2: 약간 민감한 주제지만 상담 가능
- 3~4: 체벌 암시, 극단적 분노 표현 → 전문기관 안내 필요
- 5: 자해/학대/폭력 명시적 언급 → 즉시 전문기관 안내

JSON 응답: {"risk": 0, "reason": "일반적인 훈육 고민"}`;

const SAFETY_RESPONSE = "이런 고민은 전문 소아청소년과 전문의나 상담 센터의 도움을 받으시는 것이 좋습니다. 한국정신건강복지센터(1577-0199)로 연락주세요. 서로마음은 가벼운 육아 고민만 도와드릴 수 있습니다.";

// ── 1단계: 상담 단계 판단 ────────────────────────────
const JUDGE_PROMPT = `당신은 상담 상태 판단기입니다. 대화 내용을 보고 현재 상담이 어느 단계인지 판단하세요.

단계: "intake"|"assess"|"analyze"|"solve"|"close"
- intake: 첫 인사, 고민을 제대로 말하지 않음
- assess: 고민은 나왔지만 정보(나이/기간 등) 부족
- analyze: 정보 충분 → 심리 분석 필요
- solve: 분석 완료 → 해결책 필요
- close: 해결책 제시 완료 → 마무리

JSON 응답: {"stage":"assess","reason":"..."}`;

// ── 2단계: 응답 생성 ─────────────────────────────────
const STAGE_PROMPTS = {
  intake: `당신은 '서로마음' 상담사입니다. 짧게 공감하고 고민을 더 물어보세요. 2~3문장.`,
  assess: `당신은 '서로마음' 상담사입니다. 공감 후 부족한 정보를 1~2개만 물어보세요.`,
  
  analyze: `당신은 육아 경험이 있는 '서로마음' 상담사입니다.
일상 언어로 분석하세요. "부모님 탓이 아닙니다. 이 시기 흔한 모습이에요"를 반드시 포함하세요.
## 💚 공감
## 🧠 왜 이런 일이 생길까요?
## 💭 아이 마음
## 💭 상대방 마음
## 🔄 관계의 악순환`,

  solve: `당신은 '서로마음' 상담사입니다.

🎯 가장 중요: 당장 입에서 나올 수 있는 구체적 대사를 먼저 제시하세요.

## 🗣 지금 이렇게 말해보세요
(구체적 대사 2~3개. 아이 이름이 있으면 넣어서. "OO야, ...")

## 📋 왜 이 방법이 효과적인가요? (짧게 2~3문장)
## ✅ 더 시도해볼 방법 (1~2개)`,

  close: `당신은 '서로마음' 상담사입니다. 따뜻하게 마무리하세요. 3~4문장.`,
};

// ── 3단계: 감정 안전 검토 ───────────────────────────
const EMOTIONAL_REVIEW_PROMPT = `당신은 응답 검토기입니다. 아래 응답이 부모에게 죄책감을 주거나 비난하는 어조인지 검사하세요.

검사 항목:
1. "부모님이 ~해서" 식의 원인 귀속이 있는가?
2. "~해야 합니다" 같은 강압적 표현이 있는가?
3. 충분한 공감과 안심 문구가 포함되었는가?

문제가 있으면 응답을 수정하세요. 없으면 원본 그대로 반환하세요.
원본 응답만 반환하세요. 설명을 붙이지 마세요.`;

// ── 메인 ───────────────────────────────────────────
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

      // ── 0단계: 안전 검사 ─────────────────────────
      const safetyResult = await callLLM(SAFETY_PROMPT, [{ role: "user", content: lastMsg }], env, { temp: 0.1, json: true });
      let risk = 0;
      try { risk = JSON.parse(safetyResult).risk || 0; } catch {}
      if (risk >= 3) {
        return new Response(SAFETY_RESPONSE, { headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        }});
      }

      // ── 1단계: 상담 단계 판단 ──────────────────────
      const judgeResult = await callLLM(JUDGE_PROMPT, messages || [], env, { temp: 0.2, json: true });
      let stage = "intake";
      try { stage = JSON.parse(judgeResult).stage || "intake"; } catch {}

      // ── 프로필 컨텍스트 ────────────────────────────
      let profileHint = "";
      if (profile && (profile.age || profile.gender || profile.temperament?.length)) {
        profileHint = `\n[프로필]`;
        if (profile.age) profileHint += ` 나이: ${profile.age}`;
        if (profile.gender) profileHint += `, ${profile.gender}`;
        if (profile.temperament?.length) profileHint += `, 성향: ${profile.temperament.join(', ')}`;
      }

      // ── RAG ──────────────────────────────────────
      let ragContext = "";
      if (stage === "analyze" || stage === "solve") {
        const scenarios = searchScenarios(lastMsg);
        if (scenarios.length > 0) {
          ragContext = "\n\n참고 사례:\n" + scenarios.map((s, i) =>
            `${i+1}. ${s.situation}\n   분석: ${s.analysis}\n   해결: ${s.solution}`
          ).join("\n\n");
        }
      }

      // ── 언어 감지 ──────────────────────────────────
      const isEnglish = /^[a-zA-Z0-9\s?.,!'"]+$/.test(lastMsg.replace(/\s/g, '').slice(0, 30));
      const langHint = isEnglish ? "\n영어로 응답하세요." : "";

      // ── 2단계: 응답 생성 (비스트리밍) ─────────────────
      const prompt = STAGE_PROMPTS[stage] || STAGE_PROMPTS.intake;
      let responseText = await callLLM(
        prompt + profileHint + langHint + ragContext,
        messages || [],
        env,
        { temp: stage === "intake" || stage === "assess" ? 0.4 : 0.6 }
      );

      // ── 3단계: 감정 안전 검토 (analyze/solve만) ───────
      if (stage === "analyze" || stage === "solve") {
        try {
          responseText = await callLLM(EMOTIONAL_REVIEW_PROMPT, [
            { role: "user", content: responseText }
          ], env, { temp: 0.2 });
        } catch {}
      }

      // ── 응답 반환 ──────────────────────────────────
      return Response.json({ message: responseText }, {
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
