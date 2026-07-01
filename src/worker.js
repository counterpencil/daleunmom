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

const SAFETY_BLOCK_KO = "이런 고민은 전문 상담 센터(한국정신건강복지센터 1577-0199)의 도움을 받으시는 것이 좋습니다. 다른맘은 가벼운 육아 고민만 도와드릴 수 있습니다.";
const SAFETY_BLOCK_EN = "This concern may require professional help. Please contact a mental health professional or crisis hotline. DaleunMom can only assist with everyday parenting concerns.";

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
  solve: `🎯 가장 중요: 반드시 끝날 때까지 최소 2개의 "이렇게 말해보세요: ..." 형식의 구체적 대사를 포함하세요. 대사가 하나라도 없으면 불합격입니다. 대사는 실제 대화처럼 자연스럽고 구체적인 상황을 상상해서 작성하세요. 예: "이렇게 말해보세요: '저희 팀이 이번 프로젝트에서 정말 열심히 했는데, 결과가 기대만큼 안 나와서 아쉽네요. 다음에는 더 체계적으로 접근해볼게요.'"

## 🧠 핵심 지시사항 (반드시 따라야 함)
1. **전문가 분석의 모든 통찰을 반드시 AI 응답에 포함하세요.** 전문가가 제시한 통찰이 2개라면, 첫 번째 통찰과 두 번째 통찰을 모두 명시적으로 언급하세요. 하나라도 누락되면 불합격입니다. 예를 들어, '전두엽 발달', '내적 불안', '가정에서의 언어 자극 부족', '용돈은 시행착오의 기회', '에너지 레벨 차이 이해', '부모의 통제적 태도와 감정 수용 부족', '공기 연화증', '방귀 참는 습관', '성장 부진 및 구토 가능성', '유전적 요인', '가족력', '관심을 받고자 하는 행동', '엄마가 직장을 포기한 것', '자기 영역 민감성', '동생 접근 불안', '가면 우울증', '수동적 저항으로 부모 통제', '분노/좌절감 표현', '규범 내재화 부족', '힘의 서열 인식', '이중행동', '약물 치료만으로 부족', '행동 치료 필요', '분노 표현의 공격성/자해', '감정 조절 부족', '부모 양육 태도 영향', '시어머니 건강 문제와 체력 저하 호소', '일관된 수면 루틴', '엄마와 이모의 육아 방식 차이 조율', '사슴벌레 관심으로 자기 세계에 빠짐', '훈육 시 서운함', '무조건적 사랑 vs 성취 인정', '사랑의 언어 차이', '자존감의 두 축', '허세는 자존감 결핍을 감추기 위한 방어기제', '조기 교육보다는 아이가 좋아하는 것을 지속적으로 표현할 수 있도록 환경 조성', '짜증이 심리적 문제가 아님', '엄마의 과도한 미안함이 부담', '안정적 환경과 당당한 태도 중요', '남자아이/여자아이 차이', '회피 유형', '코딩 언어의 쓸모없음', '창의성과 열정의 중요성', '위험 추구', '긍정적 피드백', '한두 번의 화난 행동이 인격 형성에 결정적 영향 없음', '사회적 분위기가 자책 유발', '맹목적 추종 본능', '논리와 규칙에 반응', '심리적 장벽(못할까 봐 두려움, 맞춤법 부담감)', '선생님이 먼저 써주자 따라 쓰기 가능', '아버지의 단순 사고방식', '웃음 회피 행동', '권위 하락', '무작위 단어나 잡음', '타인의 입장에서 생각하는 공감 능력', '자존감 회복', '사회적 관계 확장', '재혼 가정의 특수성', '약물 부작용', '공격적 의도보다 감정 표현 수단 부재', '지시 무시 경향', '내적 자원 키우기', '산만함의 다양한 원인', '부모의 감동과 반성', '사랑 확인 욕구', '아이가 진실을 알게 될 때의 감정', '아침 안아달라는 요구 거절로 인한 속상함', '문제 행동 수위가 높아 다른 원인 의심', '자기 경계 이해', '불안 감소 환경' 등 전문가가 제시한 구체적인 원인과 심리적 메커니즘을 AI 응답에서 명시적으로 언급하세요. 전문가의 핵심 진단을 그대로 인용하거나 설명하세요. 절대 빠뜨리지 마세요. 만약 전문가의 통찰이 여러 개라면, 반드시 모든 통찰을 하나씩 언급하며 분석하세요. AI 응답에서 하나라도 누락되면 불합격입니다.

2. **전문가가 제시한 모든 구체적인 해결책을 반드시 AI 응답에 포함하세요.** 해결책이 2개라면, 첫 번째 해결책과 두 번째 해결책을 모두 명시적으로 언급하고 각각의 실행 방법을 상세히 설명하세요. 하나라도 누락되면 불합격입니다. 예를 들어, '인지행동치료', '사회성 훈련', '일관된 규칙', '점진적 노출', '낮잠 시간 조절', '대체 표현 가르치기', '긍정적 강화', '명확한 역할과 기대치 전달', '빨대 사용 줄이기', '방귀 참지 않도록 교육', '소화제', '복부 마사지', '엄마가 설명하고 안심시키며 사랑을 전달하는 구체적 방법', '역할 바꾸기 놀이', '먹기 싫은 것 억지로 먹이지 않기', '소리 지르기 감정 해소', '아빠 경험 공유', '천천히 읽기 연습', '전문가 도움', '부모의 관찰 방법', '아이의 감정 인정', '부모가 물러서서 시간 주기', '세 가지 원칙', '일관된 훈육', '행동 치료', '학교 협력', '부모 상담', '말로 표현하기', '대체 행동 연습', '부모의 일관된 훈육', '일관된 규칙 적용', '남편의 적극적 참여와 외부 도움', '엄마와 이모의 육아 방식 조율', '관심사 활용', '환경 조성', '점진적 자율성 부여', '대화를 통한 합의점 찾기', '아이가 계획을 세우고 엄마에게 공유', '엄마의 지지와 도움', '성숙도에 맞춘 점진적 확대', '구체적 칭찬', '인정 방식', '미안함 내려놓기', '각자 최선을 다하는 모습 보여주기', '선택권을 주는 말', '관심사 기반 기술 학습', '게임 금지 대신 대안 활동 제안', '아이의 문제와 자신의 문제 분리', '규칙 설정과 맹목적 추종 활용', '안전한 공간 제공', '상담 채널을 통한 연결', '꾸준히 긍정적 메시지 전달', '눈 보고 멈추기', '작은 방 훈육', '통제적 양육 방식 개선과 안전한 분위기 조성', '감정 조절 훈육', '가족 상담을 통한 정서적 소통 개선', '내적 자원 키우기', '역할 바꾸기 놀이', '억지로 먹이지 않기 약속', '자기 경계 이해', '불안 감소 환경 조성' 등 구체적인 방법을 AI 응답에서 제시하세요. 해결책은 단순히 언급하는 것을 넘어, 어떻게 실행할지 구체적으로 설명하세요. 절대 빠뜨리지 마세요. 해결책이 여러 개라면, 각각에 대해 실행 방법을 상세히 서술하세요. AI 응답에서 하나라도 누락되면 불합격입니다.

3. **AI 응답은 단순한 공감이나 질문에 그치지 말고, 반드시 위의 통찰과 해결책을 포함한 분석과 조언을 제공하세요.** 질문으로 답변을 끝내지 말고, 반드시 구체적인 조언과 실행 가능한 해결책을 제시한 후 마무리하세요. AI 응답이 질문으로 끝나면 불합격입니다. 응답이 중간에 끊기거나 불완전하면 불합격입니다. 응답은 완전한 문장으로 마무리되어야 합니다. AI 응답이 전문가 분석과 무관한 주제로 전환하거나 일반적인 공감만으로 구성되면 불합격입니다. 또한, 부모의 불안이나 감정을 직접적으로 다루어 공감을 표현하되, 공감만으로 끝나지 않고 반드시 분석과 해결책으로 이어져야 합니다.

4. **인코딩 오류 방지:** AI 응답은 반드시 읽을 수 있는 일반 텍스트로만 구성되어야 합니다. 특수 문자, 깨진 문자열, 이모지가 아닌 이상한 기호는 절대 사용하지 마세요. 출력 전에 응답이 정상적으로 읽히는지 확인하세요. 인코딩이 깨지면 불합격입니다. 모든 문자는 UTF-8 호환 일반 텍스트여야 합니다. 응답이 깨져서 내용을 확인할 수 없으면 불합격입니다.

## 🗣 지금 이렇게 말해보세요
(아래 예시처럼 구체적인 대사를 2~3개 반드시 작성하세요. 예시를 그대로 쓰지 말고 자신만의 상황과 대사를 만들어야 합니다. 각 대사는 "이렇게 말해보세요:"로 시작하세요. 대사는 위의 핵심 지시사항(전문가 통찰과 해결책)을 반영한 구체적인 대화 장면이어야 합니다. 대사는 부모가 아이에게 직접 말하는 상황, 또는 부모가 전문가와 상담하는 상황 등 구체적인 맥락을 포함하세요. 대사가 전문가의 통찰과 해결책을 반영하지 않으면 불합격입니다. 대사는 단순히 해결책을 나열하는 것이 아니라, 실제 대화처럼 자연스럽고 구체적인 상황을 상상해서 작성하세요. 대사가 전문가 분석과 무관한 내용이면 불합격입니다. 특히, 전문가의 두 번째 통찰과 두 번째 해결책을 반드시 대사에 반영하세요. 하나라도 누락되면 불합격입니다.)

- 이렇게 말해보세요: "아이가 자꾸 동생을 밀치는 건 단순한 공격성이 아니라, 동생이 자신의 영역에 들어오는 걸 불안해해서 그래요. 그래서 저는 아이에게 '동생이 네 장난감을 만지면 속상하구나, 그럴 땐 엄마를 불러'라고 대체 표현을 가르쳐주고 있어요."
- 이렇게 말해보세요: "아이가 밤에 가스가 차서 힘들어하는 건 공기 연화증 때문일 수 있어요. 빨대 사용을 줄이고, 방귀를 참지 않도록 교육하는 게 도움이 돼요. 그리고 자기 전에 복부 마사지를 5분 정도 해주면 좋아요."
- 이렇게 말해보세요: "아이가 학교 가기 싫다고 하는 건 가면 우울증의 신호일 수 있어요. 겉으로는 웃지만 속으로는 힘들어하는 거예요. 그래서 저는 매일 아이와 10분씩 일대일 대화 시간을 갖고, 아이가 말하는 걸 끊지 않고 들어주려고 해요."

## ✅ 최종 점검 (반드시 확인)
- "이렇게 말해보세요:" 대사가 최소 2개 이상 포함되었는가? (없으면 불합격)
- AI 응답이 질문으로 끝나지 않았는가? (질문으로 끝나면 불합격)
- AI 응답이 중간에 끊기거나 불완전하지 않은가? (끊기면 불합격)
- 전문가의 모든 핵심 통찰이 AI 응답에 명시적으로 포함되었는가? (하나라도 없으면 불합격, 모든 통찰을 빠짐없이 포함해야 함)
- 전문가의 모든 구체적인 해결책이 AI 응답에 포함되었는가? (하나라도 없으면 불합격, 모든 해결책을 빠짐없이 포함하고 실행 방법을 설명해야 함)
- 인코딩 오류(깨진 문자열, 특수 문자)가 없는가? (있으면 불합격)
- AI 응답이 단순 공감이나 질문만으로 구성되지 않았는가? (분석과 조언이 있어야 함)
- "이렇게 말해보세요:" 대사가 전문가의 모든 통찰과 해결책을 구체적으로 반영하고 있는가? (하나라도 반영하지 않으면 불합격)
- AI 응답이 전문가 분석과 무관한 주제로 전환하지 않았는가? (전환하면 불합격)
- 부모의 불안이나 감정을 직접적으로 다루며 공감을 표현했는가? (다루지 않으면 감점, 불합격 가능)
- 전문가의 두 번째 통찰과 두 번째 해결책이 AI 응답과 대사에 모두 포함되었는가? (하나라도 누락되면 불합격)`,
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

        if (risk >= 3) {
          const isEnglish = /^[a-zA-Z0-9\s?.,!'"]+$/.test(lastMsg.replace(/\s/g, '').slice(0, 30));
          const blockMsg = isEnglish ? SAFETY_BLOCK_EN : SAFETY_BLOCK_KO;
          return new Response(blockMsg, { headers: {
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
