import {readFile, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export function reviewPolicy(questions, register) {
  if (!Array.isArray(questions) || !questions.length || !Array.isArray(register?.blockers) || register.schemaVersion !== 1) throw Error('Invalid review register');
  const ids = new Set(questions.map(q => q.id)), seen = new Set();
  for (const entry of register.blockers) {
    if (!ids.has(entry.id) || seen.has(entry.id) || !['open', 'resolved'].includes(entry.status)) throw Error('Invalid review entry');
    seen.add(entry.id);
  }
  return {schemaVersion: 1, reviewDate: register.reviewDate,
    blockedQuestionIds: register.blockers.filter(entry => entry.status !== 'resolved').map(entry => entry.id).sort(),
    commercialApprovedCount: 0};
}

export async function exportReviewPolicy() {
  const [questions, register] = await Promise.all([
    readFile(new URL('../dist/questions.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../docs/question-review-blockers.json', import.meta.url), 'utf8').then(JSON.parse)
  ]);
  const policy = reviewPolicy(questions, register);
  await writeFile(new URL('../dist/content-review.json', import.meta.url), JSON.stringify(policy, null, 2) + '\n');
  console.log(`已產生停用清單：${policy.blockedQuestionIds.length} 題；沒有匯入或核准任何題目。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  exportReviewPolicy().catch(() => {console.error('FAIL：停用清單無效，沒有產生新內容。'); process.exitCode = 1;});
}
