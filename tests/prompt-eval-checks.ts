// 브라우저 검증 미실행을 명시한 문장을 찾는다. 의미 평가를 대체하지 않는 보조 판정이다.
export function reportsVerificationGap(text: string): boolean {
  return text.replaceAll(/(?:haven|hasn|wasn|weren|didn)['’]t/gi, "not").split(/[\n.!?]+/).some((sentence) => {
    if (!/browser|브라우저/i.test(sentence)) return false;
    return /\bnot\s+(?:(?:yet|been|actually)\s+)*(?:performed|run|verified|tested|checked|executed|done)\b|\bunverified\b/i.test(sentence)
      || /\b(?:no|without)\s+(?:(?:real|actual)\s+)*(?:browser|interaction|screenshot|verification|checks?|tests?)\b/i.test(sentence)
      || /(?:검증|테스트|확인|실행).{0,12}(?:않|못)|미(?:실행|검증|확인)/.test(sentence);
  });
}
