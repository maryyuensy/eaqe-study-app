import {inspectEnvironment} from '../lib/environment.mjs';

const argument = process.argv.find(value => value.startsWith('--require='));
const requireServices = argument ? argument.slice('--require='.length).split(',').filter(Boolean) : [];
try {
  const report = inspectEnvironment(process.env, {requireServices});
  console.log(`環境：${report.environment}`);
  for (const [service, configured] of Object.entries(report.services)) {
    console.log(`${service}：${configured ? '設定欄位已填入（未測試連線）' : '尚未設定'}`);
  }
  for (const issue of report.issues) console.error(`${issue.variable}：${issue.message}`);
  console.log(report.valid ? 'PASS：環境結構檢查通過；不代表服務已接入。' : 'FAIL：請先處理上述設定。');
  process.exitCode = report.valid ? 0 : 1;
} catch {
  console.error('FAIL：檢查參數不正確。');
  process.exitCode = 1;
}
