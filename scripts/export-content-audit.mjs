import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const questions = JSON.parse(await readFile(resolve(projectRoot, 'dist/questions.json'), 'utf8'));
const output = resolve(projectRoot, 'docs/content-source-rights-audit.csv');

if (!Array.isArray(questions) || questions.length === 0) {
  throw new Error('題庫必須為非空陣列。');
}

const ids = questions.map(question => question.id);
if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
  throw new Error('題目 ID 缺漏或重複，不能建立審核登記冊。');
}

const columns = [
  'question_id',
  'version',
  'exam_tracks',
  'syllabus_part',
  'review_status',
  'source_type',
  'source_reference',
  'transformation_notes',
  'rights_basis',
  'answer_source',
  'verified_date',
  'reviewer',
  'approved_for_publication',
  'decision_notes'
];

const csvCell = value => {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"' && cell.length === 0) {
      quoted = true;
    } else if (character === ',') {
      row.push(cell);
      cell = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && csv[index + 1] === '\n') index += 1;
      row.push(cell);
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }

  if (quoted) throw new Error('既有 CSV 有未關閉的引號。');
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some(value => value !== '')) rows.push(row);
  }
  return rows;
}

let previous = new Map();
try {
  const parsed = parseCsv(await readFile(output, 'utf8'));
  const [header, ...dataRows] = parsed;
  if (header.join('\0') !== columns.join('\0')) {
    throw new Error('既有 CSV 欄位與目前格式不同；保留檔案不作覆寫。');
  }
  previous = new Map(dataRows.map(row => {
    if (row.length !== columns.length || !row[0]) throw new Error('既有 CSV 含不完整資料列；保留檔案不作覆寫。');
    return [row[0], Object.fromEntries(columns.map((column, index) => [column, row[index]]))];
  }));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const currentIds = new Set(questions.map(question => question.id));
const records = questions.map(question => {
  const existing = previous.get(question.id) ?? {};
  return {
    ...existing,
    question_id: question.id,
    version: String(question.version),
    exam_tracks: (question.examTracks ?? []).toSorted().join('|'),
    syllabus_part: String(question.part),
    review_status: existing.review_status || '未審核',
    approved_for_publication: existing.approved_for_publication || '否（待審）'
  };
});

for (const [id, existing] of previous) {
  if (!currentIds.has(id)) {
    records.push({
      ...existing,
      review_status: existing.review_status || '題庫已移除，待核實是否保留審核紀錄',
      approved_for_publication: '否（待審）'
    });
  }
}

const rows = [columns, ...records
  .toSorted((a, b) => a.question_id.localeCompare(b.question_id))
  .map(record => columns.map(column => record[column] ?? ''))
].map(row => row.map(csvCell).join(',')).join('\n');

await writeFile(output, `${rows}\n`, 'utf8');
console.log(`已核對 ${questions.length} 條現行題目，登記冊共 ${records.length} 條（包含已移除題目的歷史紀錄）。既有人工審核欄位會保留；題目正文未被複製。`);
