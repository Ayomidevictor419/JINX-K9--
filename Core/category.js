const SETS = {
  OWNER: new Set(['owner','setprefix','settheme','theme','setcmd','delcmd','listcmd','getsudo','getmod','setvar','broadcast','sudo','delsudo','mod','delmod','mode']),
  GROUP: new Set(['antilink','antibot','antigroupmention','antigroupstatus','antitag','welcome','setwelcome','setgoodbye','goodbye','antipromote','antidemote','forceviewonce','antifamily','muteuser','unmuteuser','linkgc','revoke','close','open','setname','setdesc','listadmins','setgcpp','delpp','requests','approveall','rejectall','approve','membermode','ephemeral','groupstats','rules','setrules','groupinfo','del','warns','warn','resetwarn','warnlist','warnlimit','slowmode','antispam','punch','kick','kickall','promote','demote','hidetag','listonline','listoffline','totalmessage','join','leave','gname','gdesc','glink','creategc','ginfo','addnote','delnote','allnotes','getnote','delallnote','antibadword','antiforeign','purge','tagall','mute','unmute','pin','unpin']),
  DOWNLOADER: new Set(['play','ytmp3','ytmp4','ytsearch','songinfo','video','spotify','tiktok','ig','fb','mediafire','gdrive','gitclone','playdoc','apk','apkdl','app','ytdl']),
  AI: new Set(['ai','chatbot','gpt','openai','gemini','deepseek','mistral','llama','coder','imagine','aiimage','imageai','aistatus','search','google','translate','trans','transcribe','transcript','stt']),
  MEDIA: new Set(['s','sticker','vv','viewonce','readvo','getpp','pp','ss','sstab','ssphone','ssfull','wm','toimg','photo','tomp4','take','hd','remini','upscale','compress','ngif']),
  CONVERTER: new Set(['mp3','tovn','tomp3','emojimix','emix','tts','audio2text']),
  AUDIO: new Set(['bass','blown','deep','earrape','fast','fat','nightcore','reverse','squirrel','robot','slow','smooth','chipmunk','flanger','tremolo','vibrato','8d']),
  GAMES: new Set(['wordgame','startgame','endgame','tictactoe','quiz','rps']),
  FUN: new Set(['slap','hug','kiss','pat','cuddle','tickle','feed','smug','bully','cry','highfive','handhold','bite','lick','kill','dance','wink','poke','bonk','yeet','blush','smile','wave','happy','sad','angry','cringe','neko','waifu','meow','woof','goose','lizard','foxgirl']),
  SPORTS: new Set(['weather','football']),
  TOOLS: new Set(['quote','remind','wallpaper','url','tinyurl','calc','define','wiki','bible','style','readmore','getdevice','repo','afk','alwaysonline','rejectcall','antidelete','antiedit','report','block','unblock','clear','ip','temp-url','pdf','trt','ngl','pfilter','pstop','gfilter','gstop','check']),
  STATUS: new Set(['status','statusreact','statussave','autostatus','savestatus','statusview','gcstatus']),
  SYSTEM: new Set(['runtime','doctor','jid','commands','version','stats'])
};
const ORDER=['MAIN','OWNER','GROUP','DOWNLOADER','AI','MEDIA','CONVERTER','AUDIO','GAMES','FUN','SPORTS','TOOLS','STATUS','SYSTEM','UTILITY'];
function categoryFor(name, fallback='UTILITY') {
  const n=String(name||'').toLowerCase();
  for (const c of ORDER) if (SETS[c]?.has(n)) return c;
  return String(fallback||'UTILITY').toUpperCase();
}
module.exports={SETS,ORDER,categoryFor};
