(()=>{
const today=new Date(Date.now()+9*3600e3).toISOString().slice(0,10);
const addD=(d,n)=>new Date(Date.parse(d)+n*864e5).toISOString().slice(0,10);
const range=(a,n)=>Array.from({length:n},(_,i)=>addD(a,i));
const hrs=d=>{const o=[];for(let x of d)for(let h=0;h<24;h++)o.push(x+'T'+String(h).padStart(2,'0')+':00');return o};
const days=range(addD(today,-1),17), D7=days.slice(1,8), H=hrs(days), H7=hrs(D7);
const nowT=new Date(Date.now()+9*3600e3).toISOString().slice(0,13)+':00';
window.__calls=[];
const J=o=>Promise.resolve({ok:true,json:async()=>o});
if(!localStorage.getItem('weather:favs')) localStorage.setItem('weather:favs', JSON.stringify([{name:'강릉시 교1동',lat:37.76,lon:128.89,sel:null},{name:'제주시 노형동',lat:33.48,lon:126.48,sel:null}]));
const one=(id,k)=>{const kma=id.startsWith('kma');return {d:{temperature_2m_max:D7.map((_,i)=>kma?null:17+Math.sin(i+k)*2),temperature_2m_min:D7.map(()=>kma?null:6+k*0.4),precipitation_sum:D7.map((_,i)=>kma?null:(i===2?k:0)),wind_speed_10m_max:D7.map(()=>kma?null:3+k*0.5)},h:{temperature_2m:H7.map((_,i)=>kma?null:12+k*0.3+5*Math.sin(i/4)),precipitation:H7.map(()=>kma?null:0),wind_speed_10m:H7.map(()=>kma?null:2)}}};
window.fetch=(u)=>{ __calls.push(u);
 if(window.__offline) return Promise.reject(new TypeError('Failed to fetch'));
 // 기상청 중계 서버(worker/kma-worker.js) 흉내: 주소에 /now?, /fcst? 가 들어가면
 if(window.__kmaFail && /\/(now|fcst)\?/.test(u)) return J({ok:false,error:window.__kmaFail});
 if(u.includes('/now?')) return J({ok:true,nx:60,ny:127,base:nowT.slice(0,11)+String(Math.max(0,+nowT.slice(11,13)-1)).padStart(2,'0')+':00',obs:{t:14.6,rh:62,wind:1.4,vec:250,rain1h:0,pty:window.__kmaPty||0},
  ultra:{base:nowT.slice(0,14)+'30',time:[1,2,3,4,5,6].map(i=>new Date(Date.parse(nowT+':00Z')+i*3600e3).toISOString().slice(0,13)+':00'),t:[15,15.5,16,15,14,13],rain:[0,0,0,0.5,1,0],sky:[1,1,3,4,4,4],pty:[0,0,0,1,1,0],reh:[60,60,60,70,80,80],wsd:[1,1,2,2,3,3],vec:[270,270,250,200,180,180],lgt:[0,0,0,0,0,0]}});
 if(u.includes('/air?')) return J(window.__airFail?{ok:false,error:window.__airFail}:{ok:true,station:'중구',addr:'서울 중구 덕수궁길 15',dist:1.2,dataTime:today+' 20:00',pm10:52,pm25:31,pm10Grade:2,pm25Grade:2,khai:80,khaiGrade:2});
 if(u.includes('/obs?')) return J({ok:true,nx:60,ny:127,days:window.__obsDays||[]});
 if(u.includes('/warn?')) return J(window.__warn||{ok:true,tmFc:today+'T10:00',active:[{name:'건조주의보',part:false},{name:'강풍주의보',part:true}],prelim:['(1) 강풍 예비특보 : 10월 30일 새벽(00시~06시) : 서울, 인천, 경기도'],nation:3});
 if(u.includes('/push/key')) return J({ok:true,key:'BKxx'});
 if(/\/push\/(subscribe|unsubscribe|test)/.test(u)) return J({ok:true,alertHour:7,status:201});
 if(u.includes('/fcst?')){const t=[];for(let i=0;i<70;i++)t.push(new Date(Date.parse(nowT+':00Z')+i*3600e3).toISOString().slice(0,13)+':00');
  const ds=[...new Set(t.map(x=>x.slice(0,10)))];
  return J({ok:true,nx:60,ny:127,base:today+'T11:00',hourly:{time:t,tmp:t.map((_,i)=>12+4*Math.sin(i/4)),pop:t.map(()=>20),pcp:t.map((_,i)=>i===30?1:0),sno:t.map(()=>0),sky:t.map(()=>3),pty:t.map(()=>0),reh:t.map(()=>60),wsd:t.map(()=>2.5)},
   daily:{time:ds,tmx:ds.map((_,i)=>i===0?null:18+i),tmn:ds.map((_,i)=>i===0?null:5+i)}});}
 if(u.includes('archive')){const t=range('1991-01-01',366*2);return J({daily:{time:t,temperature_2m_max:t.map(()=>16),temperature_2m_min:t.map(()=>6)}});}
 if(u.includes('air-quality')) return J({current:{pm10:38,pm2_5:12},hourly:{time:hrs(days.slice(1,3)),pm10:hrs(days.slice(1,3)).map(()=>40),pm2_5:hrs(days.slice(1,3)).map(()=>14)}});
 if(u.includes('past_days=31')){const t=range(addD(today,-31),32);return J({daily:{time:t,temperature_2m_max:t.map(()=>18),temperature_2m_min:t.map(()=>7),precipitation_sum:t.map(()=>0)}});}
 if(u.includes('forecast_days=8')){const t=range(today,8);const lats=u.match(/latitude=([^&]+)/)[1].split(',').map(Number);const res=lats.map(lat=>({daily:{time:t,weather_code:t.map(()=>lat>37.7?0:61),temperature_2m_max:t.map(()=>19),temperature_2m_min:t.map(()=>10),precipitation_probability_max:t.map(()=>lat>37.7?10:60)}}));return J(res.length>1?res:res[0]);}
 if(u.includes('models=')){const ids=u.match(/models=([^&]+)/)[1].split(',');const multi=ids.length>1;const o={utc_offset_seconds:32400,daily:{time:D7},hourly:{time:H7}};
  ids.forEach((id,k)=>{const x=one(id,k);const s=multi?'_'+id:'';for(const a in x.d)o.daily[a+s]=x.d[a];for(const a in x.h)o.hourly[a+s]=x.h[a];});return J(o);}
 return J({utc_offset_seconds:32400,current:{time:nowT,temperature_2m:17,apparent_temperature:16,relative_humidity_2m:50,weather_code:1,wind_speed_10m:2.3,is_day:1,precipitation:0},
  hourly:{time:H,temperature_2m:H.map((_,i)=>11+5*Math.sin((i-9)/24*2*Math.PI)),apparent_temperature:H.map(()=>15),weather_code:H.map(()=>1),precipitation_probability:H.map(()=>5),is_day:H.map((_,i)=>i%24>6&&i%24<18?1:0),uv_index:H.map(()=>4),relative_humidity_2m:H.map(()=>45),wind_speed_10m:H.map((_,i)=>2+(i%7)),precipitation:H.map((_,i)=>i%24>=15&&i%24<=17?1.2:0),wind_direction_10m:H.map((_,i)=>(i*15)%360)},
  daily:{time:days,weather_code:days.map(()=>1),temperature_2m_max:days.map((_,i)=>19-(i%5)),temperature_2m_min:days.map((_,i)=>7+(i%3)),precipitation_probability_max:days.map(()=>10),sunrise:days.map(d=>d+'T06:50'),sunset:days.map(d=>d+'T17:40'),daylight_duration:days.map(()=>39000),uv_index_max:days.map(()=>5),wind_speed_10m_max:days.map(()=>4)}});
};})();
