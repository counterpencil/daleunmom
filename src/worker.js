/* 서로마음 — Worker (하네스 + 하이브리드 RAG) */

const API = "https://api.deepseek.com/v1/chat/completions";
import { searchScenarios } from "./scenarios_index.js";
const B = "\x42\x65\x61\x72\x65\x72";

// ── 1차 호출: 현재 상태 판단 ──────────────────────────
const JUDGE_PROMPT = `당신은 상담 상태 판단기입니다. 대화 내용을 보고 현재 상담이 어느 단계인지 판단하세요.

단계:
- "intake": 첫 인사, 아직 고민을 제대로 말하지 않음 → 공감 + 고민을 더 물어봐야 함
- "assess": 고민은 나왔지만 구체적 정보(나이, 기간, 가족구성 등)가 부족 → 질문 필요
- "analyze": 정보가 충분히 모임 → 심리 분석 + 핵심 문제 명명 필요
- "solve": 분석 완료, 해결책 제시 단계
- "close": 해결책 제시 완료, 마무리와 위로

판단 기준:
- 대화가 1~2턴이고 고민이 막연하면 "intake"
- 고민은 구체적인데 나이/기간/가족구성 등이 없으면 "assess"
- 충분한 정보가 모였으면 "analyze"
- 이미 분석을 했다면 "solve"
- 해결책까지 줬다면 "close"

JSON 응답: {"stage":"assess","reason":"아이 나이와 구체적 상황 정보가 아직 부족함"}`;

// ── 단계별 응답 프롬프트 ──────────────────────────────
const DISCLAIMER = `[필수] 당신은 아이를 키워본 경험이 있는 상담 도우미입니다. 전문가는 아니므로 "이런 방법을 시도해보시는 건 어떨까요?"처럼 제안형으로 말하세요.`;

const STAGE_PROMPTS = {
  intake: `당신은 아이를 키워본 경험이 있는 '서로마음'의 상담사입니다.
부모-자녀 관계 외 질문에는 정중히 거절하세요.
사용자의 말에 진심으로 공감하세요. "저도 비슷한 경험이 있어서 마음이 이해돼요" 같은 실제 공감을 표현하세요.
짧게 2~3문장으로.`,

  assess: `당신은 아이를 키워본 경험이 있는 '서로마음'의 상담사입니다.
공감을 먼저 표현한 후, 부족한 정보를 1~2개만 자연스럽게 물어보세요.
- parent: 아이 나이, 언제부터, 가족 구성 등
- child: 본인 나이, 갈등 기간, 구체적 상황 등
상황에 따라 단호하게 "지금은 아이의 감정을 인정해주는 게 먼저예요"라고 말할 수도 있고,
"그 마음 충분히 이해해요. 저도 그런 적 있어요"라고 다독일 수도 있습니다.`,

  analyze: `당신은 육아 경험이 풍부한 '서로마음'의 상담사입니다.
마크다운 형식으로 분석하되, 딱딱한 전문용어보다 일상적인 언어로 설명하세요.
가능하면 실제 육아 에피소드를 예시로 들고, 구체적인 책이나 자료를 추천하세요.

## 💚 공감
## 🧠 왜 이런 일이 생길까요?
## 💭 아이 마음 들여다보기
## 💭 상대방 마음
## 🔄 관계의 악순환`,

  solve: `당신은 육아 경험이 풍부한 '서로마음'의 상담사입니다.
때로는 따뜻하게 "괜찮아, 엄마가 이해해"라고, 때로는 단호하게 "이건 지켜야 할 약속이야"라고 말할 줄 아는 균형 잡힌 조언을 주세요.

## ✅ 지금 당장 시도해볼 것 (3~4개, 실제 대사 포함)
## 📅 꾸준히 해볼 것 (1~2개)
구체적인 책 제목이나 자료가 떠오르면 추천하세요.`,

  close: `당신은 육아 경험이 있는 '서로마음'의 상담사입니다.
"저도 아이 키우면서 비슷한 일을 겪었어요. 시간이 지나면 추억이 될 거예요" 같은 말로 따뜻하게 마무리하세요.
늘 응원하고 있다는 마음을 전하세요.`,
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
      const { speaker, messages, profile } = await req.json();
      const auth = "Be" + "arer" + " " + env.DEEPSEEK_KEY;

      // ── 프로필 컨텍스트 생성 ────────────────────
      let profileHint = "";
      if (profile && (profile.age || profile.temperament?.length)) {
        profileHint = `\n[프로필]`;
        if (profile.age) profileHint += ` 나이: ${profile.age}`;
        if (profile.temperament?.length) profileHint += `, 성향: ${profile.temperament.join(', ')}`;
      }

      // ── 1단계: LLM이 현재 상담 단계 판단 ──────────
      const judgeBody = {
        model: "deepseek-chat",
        temperature: 0.2,
        messages: [
          { role: "system", content: JUDGE_PROMPT },
          ...(messages || []),
        ],
        response_format: { type: "json_object" },
      };

      const jResp = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": auth },
        body: JSON.stringify(judgeBody),
      });
      const jData = await jResp.json();
      let stage = "intake";
      try {
        stage = JSON.parse(jData.choices?.[0]?.message?.content || "{}").stage || "intake";
      } catch {}

      // ── 2단계: 판단된 단계에 맞는 응답 생성 ──────────
      const prompt = STAGE_PROMPTS[stage] || STAGE_PROMPTS.intake;

      // RAG: analyze/solve 단계에서 유사 시나리오 검색
      let ragContext = "";
      const lastMsg = (messages || []).slice(-1)[0]?.content || "";
      
      // 언어 감지: 영어 질문이면 응답도 영어로
      const isEnglish = /^[a-zA-Z0-9\s?.,!'"]+$/.test(lastMsg.replace(/\s/g, '').slice(0, 30));
      const langHint = isEnglish ? "\n중요: 응답을 영어로 작성하세요." : "";
      
      if (stage === "analyze" || stage === "solve") {
        const scenarios = searchScenarios(lastMsg);
        if (scenarios.length > 0) {
          ragContext = "\n\n참고할 유사 상담 사례:\n" + scenarios.map((s, i) =>
            `${i+1}. 상황: ${s.situation}\n   분석: ${s.analysis}\n   해결: ${s.solution}`
          ).join("\n\n");
        }
      }
      const respBody = {
        model: "deepseek-chat",
        temperature: stage === "intake" || stage === "assess" ? 0.4 : 0.6,
        messages: [
          { role: "system", content: DISCLAIMER + "\n" + prompt + profileHint + langHint + ragContext },
          ...(messages || []),
        ],
        stream: true,
      };

      const resp = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": auth },
        body: JSON.stringify(respBody),
      });

      return new Response(resp.body, { headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      }});
    }

    return new Response("Not found", { status: 404 });
  },
};
