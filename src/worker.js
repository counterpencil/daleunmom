/* 서로마음 — Cloudflare Worker (DeepSeek API 중계 + D1 로깅) */

const DEEPSEEK_API = "https://api.deepseek.com/v1/chat/completions";
const SYSTEM_PROMPTS = {
  parent: `당신은 '서로마음'의 상담사입니다. 부모로서 아이 고민을 듣고 있습니다. 5단계(듣기→파악하기→짚기→손내밀기→마무리)로 응대하세요. 정보가 부족하면 자연스럽게 되묻고, 충분하면 심리분석과 구체적 해결책을 제시하세요. JSON 출력 형식: {"message":"...", "stage":"assessment", "next_stage":"formulation", "needs_input":false}`,
  
  child: `당신은 '서로마음'의 상담사입니다. 자녀로서 부모님 고민을 듣고 있습니다. 5단계(듣기→파악하기→짚기→손내밀기→마무리)로 응대하세요. 사용자는 '아이'이므로 "아이의 나이" 대신 "본인의 나이"라고 물어보세요. 정보가 부족하면 자연스럽게 되묻고, 충분하면 심리분석과 구체적 해결책을 제시하세요. 상대방(부모님)의 심리도 반드시 분석하세요. JSON 출력 형식: {"message":"...", "stage":"assessment", "next_stage":"formulation", "needs_input":false}`,
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // CORS
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" },
      });
    }

    // POST /chat → DeepSeek API
    if (url.pathname === "/chat" && req.method === "POST") {
      const body = await req.json();
      const { speaker, messages } = body;

      const systemMsg = { role: "system", content: SYSTEM_PROMPTS[speaker] || SYSTEM_PROMPTS.child };

      const resp = await fetch(DEEPSEEK_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.DEEPSEEK_KEY}`,
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          temperature: 0.5,
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

      // D1 로깅 (에러 무시)
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
