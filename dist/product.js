export const product={
  name:'地產牌研所',
  englishName:'PropExam HK',
  tagline:'大牌・細牌一站式備試',
  price:238,
  accessDays:60,
  freePart:1,
  supportEmail:'',
  updatedAt:'2026-09-22'
};

export const tracks={
  eaqe:{
    id:'eaqe',short:'大牌',name:'地產代理資格考試',code:'EAQE',parts:[1,2,3,4,5,6,7,8],
    duration:'3 小時',format:'30 道獨立題＋20 道個案題',pass:'第一部分最少 18/30；第二部分最少 12/20'
  },
  sqe:{
    id:'sqe',short:'細牌',name:'營業員資格考試',code:'SQE',parts:[1,2,3,4,5,7],
    duration:'2 小時 30 分鐘',format:'40 道獨立題＋10 道個案題',pass:'第一部分最少 24/40；第二部分最少 6/10'
  }
};

export const parts=[
  {id:1,title:'香港地產代理業概覽',short:'行業概覽'},
  {id:2,title:'《地產代理條例》及地產代理實務',short:'條例及代理實務'},
  {id:3,title:'相關法例及物業轉易程序',short:'相關法例'},
  {id:4,title:'土地註冊、查冊及物業資料',short:'土地查冊'},
  {id:5,title:'樓宇知識、物業分類及管理',short:'樓宇及管理'},
  {id:6,title:'物業估價原則與實務',short:'物業估價',eaqeOnly:true},
  {id:7,title:'批租及租務事宜',short:'租務'},
  {id:8,title:'業務管理及營業員監督',short:'管理及監督',eaqeOnly:true}
];

export const officialSources={
  exam:'https://www.eaa.org.hk/zh-hk/Examination/Exam',
  handbook:'https://www.eaa.org.hk/zh-hk/Examination/Examination-Handbook',
  schedule:'https://www.eaa.org.hk/zh-hk/Examination/Registration-details-post-registration-matters',
  verifiedAt:'2026-09-22'
};
