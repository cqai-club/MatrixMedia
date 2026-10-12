"use strict";

const DISCLOSURES = {
  none: "",
  ai_generated: "本文包含 AI 生成内容",
  fiction: "虚构演绎，仅供娱乐",
  marketing: "营销推广",
  personal_opinion: "个人观点，仅供参考",
  repost: "转载",
  self_made_no_repost: "自制，禁止转载",
};

export function withDisclosure(body, statement) {
  const text = DISCLOSURES[statement] || "";
  return text ? `${body.trimEnd()}\n\n> 内容声明：${text}` : body;
}
