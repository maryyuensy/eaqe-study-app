// Only published sittings are listed. Refresh from EAA/PEAK when a new timetable appears.
export const verifiedAt='2026-09-22';
export const scheduleUrl='https://www.eaa.org.hk/zh-hk/Examination/Registration-details-post-registration-matters';
export const handbookUrl='https://www.eaa.org.hk/zh-hk/Examination/Examination-Handbook';
export const exams=[
 {id:'EAQE-20260922',track:'eaqe',date:'2026-09-22',time:'14:30–17:30',opens:'2026-08-18',postalDeadline:'2026-09-01',onlineDeadline:'2026-09-08'},
 {id:'SQE-20261020',track:'sqe',date:'2026-10-20',time:'14:30–17:00',opens:'2026-09-15',postalDeadline:'2026-09-29',onlineDeadline:'2026-10-06'},
 {id:'SQE-20261117',track:'sqe',date:'2026-11-17',time:'14:30–17:00',opens:'2026-10-13',postalDeadline:'2026-10-27',onlineDeadline:'2026-11-03'},
 {id:'EAQE-20261215',track:'eaqe',date:'2026-12-15',time:'14:30–17:30',opens:'2026-11-10',postalDeadline:'2026-11-24',onlineDeadline:'2026-12-01'}
].map(exam=>({...exam,source:scheduleUrl}));
export const selectableExams=(today,selected='',track='eaqe')=>exams.filter(exam=>exam.track===track&&(exam.date>=today||exam.date===selected));
export function registrationStatus(exam,today){return today<exam.opens?'尚未開始報名':today>exam.onlineDeadline?'報名已截止':'報名期內・名額以官方為準'}
