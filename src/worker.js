/* 서로마음 — Worker (안전검사 → 응답생성 → 감정검토 → 스트리밍) */

const API = "https://api.deepseek.com/v1/chat/completions";
import { searchScenarios } from "./scenarios_index.js";

async function callLLM(sys, msgs, env, opts = {}) {
  const auth = "Be" + "arer" + " " + env.DEEPSEEK_KEY;
  const resp = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },/g    body: JSON.stringify({
      model: "deepseek-chat",
      temperature: opts.temp || 0.4,
      messages: [{ role: "system", content: sys }, ...(msgs || [])],
      response_format: opts.json ? { type: "json_object" } : undefined,
    }),
  });
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "";
}

// ── 가짜 스트리밍: 텍스트를 청크로 나눠 SSE 전송 ──────
function fakeStream(text) {
  const encoder = new TextEncoder();
  let pos = 0;
  const chunkSize = 3; // 한글 3글자씩

  const stream = new ReadableStream({
    async pull(controller) {
      if (pos >= text.length) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      const chunk = text.slice(pos, pos + chunkSize);
      pos += chunkSize;
      const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`;
      controller.enqueue(encoder.encode(sse));
      await new Promise(r => setTimeout(r, 15)); // 15ms 간격
    },
  });
  return stream;
}

// ── 1단계: 안전검사 + 단계판단 ────────────────────────
const SAFETY_JUDGE_PROMPT = `당신은 상담 안전검사기이자 단계 판단기입니다.

먼저 안전을 평가하세요 (risk 0~5):
- 0~2: 일반 육아 고민 → 계속 진행
- 3~5: 체벌/학대/자해 → 중단

안전하면 상담 단계를 판단하세요:
- "intake": 고민 막연 → 공감 + 물어보기
- "assess": 정보 부족 → 질문
- "analyze": 정보 충분 → 분석
- "solve": 분석 완료 → 해결책
- "close": 해결책 완료 → 마무리

JSON: {"risk":0,"stage":"assess","reason":"..."}`;

const SAFETY_BLOCK = "이런 고민은 전문 상담 센터(한국정신건강복지센터 1577-0199)의 도움을 받으시는 것이 좋습니다. 서로마음은 가벼운 육아 고민만 도와드릴 수 있습니다.";

// ── 2단계: 응답 생성 ─────────────────────────────────
const COMFORT = `[필수] 당신은 육아 경험이 있는 상담사입니다. 절대 부모님을 비난하지 마세요. "부모님 탓이 아닙니다"를 자연스럽게 포함하세요.`;

const STAGE_PROMPTS = {
  intake: `공감하고 고민을 더 물어보세요. 2~3문장.`,
  assess: `공감 후 부족한 정보를 1~2개만 물어보세요.`,
  analyze: `일상 언어로 분석하세요. "부모님 탓이 아닙니다"를 반드시 포함.
## 💚 공감
## 🧠 왜 이런 일이 생길까요?
## 💭 아이 마음
## 💭 상대방 마음
## 🔄 관계의 악순환`,
  solve: `🎯 구체적 대사를 먼저 제시하세요. 당장 쓸 수 있는 말이 먼저입니다.
## 🗣 지금 이렇게 말해보세요 (구체적 대사 2~3개)
## ✅ 더 시도해볼 방법 (1~2개)`,
  close: `따뜻하게 마무리하세요. 3~4문장.`,
};

// ── 3단계: 감정 검토 ─────────────────────────────────
const EMOTIONAL_REVIEW_PROMPT = `당신은 상담 응답 검토기입니다. 아래 응답을 검사하세요:

1. 부모를 비난하거나 죄책감을 주는 표현이 있는가? ("부모님이 ~해서", "~가 잘못됐다")
2. "~해야 합니다" 같은 강압적 표현이 있는가?
3. 충분한 공감이 포함되었는가?

문제가 있으면 부드럽게 수정하세요. 없으면 원본 그대로 반환하세요.
수정된 응답만 출력하세요. 설명을 붙이지 마세요.`;

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

      // ── 1단계: 안전검사 + 단계판단 ──────────────────
      const sjResult = await callLLM(SAFETY_JUDGE_PROMPT, messages || [], env, { temp: 0.2, json: true });
      let risk = 0, stage = "intake";
      try {
        const sj = JSON.parse(sjResult);
        risk = sj.risk || 0;
        stage = sj.stage || "intake";
      } catch {}

      if (risk >= 3) {
        return new Response(SAFETY_BLOCK, { headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        }});
      }

      // ── 프로필 + RAG + 언어 ──────────────────────────
      let profileHint = "";
      if (profile && (profile.age || profile.gender || profile.temperament?.length)) {
        profileHint = `\n[프로필]`;
        if (profile.age) profileHint += ` 나이: ${profile.age}`;
        if (profile.gender) profileHint += `, ${profile.gender}`;
        if (profile.temperament?.length) profileHint += `, 성향: ${profile.temperament.join(', ')}`;
      }

      let ragContext = "";
      if (stage === "analyze" || stage === "solve") {
        const scenarios = searchScenarios(lastMsg);
        if (scenarios.length > 0) {
          ragContext = "\n\n참고 사례:\n" + scenarios.map((s, i) =>
            `${i+1}. ${s.situation}\n   분석: ${s.analysis}\n   해결: ${s.solution}`
          ).join("\n\n");
        }
      }

      const isEnglish = /^[a-zA-Z0-9\s?.,!'"]+$/.test(lastMsg.replace(/\s/g, '').slice(0, 30));
      const langHint = isEnglish ? "\n영어로 응답하세요." : "";

      // ── 2단계: 응답 생성 (비스트리밍) ──────────────────
      const prompt = STAGE_PROMPTS[stage] || STAGE_PROMPTS.intake;
      const sysContent = COMFORT + "\n" + prompt + profileHint + langHint + ragContext;
      let responseText = await callLLM(sysContent, messages || [], env, {
        temp: stage === "intake" || stage === "assess" ? 0.4 : 0.6,
      });

      // ── 3단계: 감정 검토 ────────────────────────────
      if (stage === "analyze" || stage === "solve") {
        try {
          responseText = await callLLM(EMOTIONAL_REVIEW_PROMPT, [
            { role: "user", content: responseText }
          ], env, { temp: 0.2 });
        } catch {}
      }

      // ── 검토 완료된 텍스트를 스트리밍 ──────────────────
      const stream = fakeStream(responseText);
      return new Response(stream, { headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      }});
    }

    return new Response("Not found", { status: 404 });
  },
};
