function money(v){ v=Number(v); if(!isFinite(v)) v=0; if(Math.abs(v)>=1e6) return "$"+(v/1e6).toFixed(2)+"M"; if(Math.abs(v)>=1e3) return "$"+(v/1e3).toFixed(1)+"K"; return "$"+v.toFixed(2); }
function amt(v){ v=Number(v); if(!isFinite(v)) v=0; return v.toFixed(1); }
function dateTime(t){ if(!t) return "—"; return new Date(t).toLocaleTimeString("zh-TW",{hour:"2-digit",minute:"2-digit",second:"2-digit"}); }
function uid(){ return Math.random().toString(36).slice(2,10); }

var _gameTimeBase = Date.now();
var _realTimeBase = Date.now();
var _gameSpeed = 1;

function gameNow(){
  var elapsed = Date.now() - _realTimeBase;
  return _gameTimeBase + elapsed * _gameSpeed;
}

function setGameSpeed(speed){
  _gameTimeBase = gameNow();
  _realTimeBase = Date.now();
  _gameSpeed = speed;
}

function countdown(t){
  var s = Math.max(0, Math.floor((t - gameNow()) / 1000));
  if(s <= 0) return "完成";
  var m = Math.floor(s/60), sec = s%60;
  return m > 0 ? m+"m "+sec+"s" : sec+"s";
}

function gameEndTime(realSeconds){
  return gameNow() + realSeconds * 1000;
}
