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
const DISCLAIMER = `[필수] 당신은 AI 상담 도우미입니다. 전문 심리상담사가 아닙니다. "반드시 이렇게 하세요" 같은 단정 대신 "이런 방법을 시도해보시는 건 어떨까요?"처럼 제안형으로 말하세요. 모든 조언은 참고용입니다.`;

const STAGE_PROMPTS = {
  intake: `당신은 '서로마음'의 상담사입니다. 지금은 첫 대화 단계입니다.
부모-자녀 관계 외 질문에는 "상담 외 질문에는 답변드릴 수 없습니다"라고만 하세요.
사용자의 감정에 깊이 공감하고, 고민을 더 자세히 말씀해달라고 부드럽게 요청하세요.
짧게 2~3문장으로.`,

  assess: `당신은 '서로마음'의 상담사입니다. 지금은 정보 수집 단계입니다.
공감을 먼저 표현한 후, 부족한 정보를 1~2개만 자연스럽게 질문하세요.
- parent: 아이 나이, 언제부터, 가족 구성 등
- child: 본인 나이, 갈등 기간, 구체적 상황 등
사용자가 아이이면 "아이 나이" 대신 "본인 나이"라고 물어보세요.`,

  analyze: `당신은 '서로마음'의 아동심리 전문가입니다. 마크다운으로 깊이 분석하세요.
## 💚 공감
## 🧠 왜 이런 일이 생길까요? (심리학적 분석)
## 💭 아이(또는 본인) 마음 들여다보기
## 💭 상대방 마음 (부모/아이 입장에서 이해)
## 🔄 관계의 악순환
## 🏷 핵심 문제: "___ 갈등"`,

  solve: `당신은 '서로마음'의 상담사입니다. 구체적 해결책을 주세요.
프로필이 있다면 이름을 반드시 넣어서 "지훈이에게 이렇게 말해보세요: ..." 형식으로 실제 대사를 제시하세요.
## ✅ 지금 당장 할 수 있는 것 (3~4개, 실제 대사 예시 포함)
## 📅 일주일 동안 시도할 것 (1~2개)
## 💆 나를 돌보는 방법 (1개)
추상적 조언 금지. 구체적인 말투와 행동을 제시하세요.`,

  close: `당신은 '서로마음'의 상담사입니다. 상담을 따뜻하게 마무리하세요.
사용자의 용기와 솔직함에 감사하고, 충분히 잘하고 있다고 위로하세요.
도움이 필요하면 언제든 다시 찾아오라고 말씀드리세요. 3~4문장으로.`,
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
      if (profile && (profile.name || profile.age || profile.temperament?.length)) {
        const name = profile.name || "아이";
        profileHint = `\n[프로필] ${name}`;
        if (profile.age) profileHint += `, ${profile.age}`;
        if (profile.temperament?.length) profileHint += `, ${profile.temperament.join(', ')}`;
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
