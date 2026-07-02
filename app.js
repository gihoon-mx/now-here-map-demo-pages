/* ===================================================
   동 경계 뷰어 – 핵심 로직 (Vanilla JS)
   =================================================== */

var map;
var currentMode = 'local';
var PALETTE = ['#DE2F2A','#F2862E','#F2C53D','#9DC64C'];

/* ========== 로컬 모드 ========== */
var selectedFeature = null;
var smoothEnabled = false;
var smoothIntensity = 0.5;
var originalGeoJson = null;

var styleConfig = {
  default: { strokeColor:'#999999', fillColor:'#cccccc', strokeWeight:1, strokeOpacity:0.6, fillOpacity:0.12 },
  highlight: { strokeColor:'#ff3333', fillColor:'#ff3333', strokeWeight:4, strokeOpacity:1, fillOpacity:0.4 },
};

/* ========== 트렌드 모드 ========== */
var hexPolygons = [];
var selectedHexes = new Map();
var hexRadiusKm = 1.0;
var boundsListener = null;
var REF_LAT_RAD = 37.0 * Math.PI / 180;

var hexStyleConfig = {
  default: { fillColor:'#4fc3f7', strokeColor:'#0288d1', fillOpacity:0.08, strokeWeight:1, strokeOpacity:0.45 },
  selected: { fillColor:'#ff9800', fillOpacity:0.45, strokeColor:'#e65100', strokeWeight:2, strokeOpacity:1 },
};

/* ========== 트렌드 존 ========== */
var trendZones = [];
var editingZoneId = null;
var editingZoneBackup = null;

/* ========== 라벨 설정 ========== */
var localLabelConfig = { enabled:false, fontSize:12, textColor:'#ffffff', bgColor:'#111318', bgOpacity:0.72 };
var zoneLabelConfig  = { fontSize:11, textColor:'#ffffff', bgOpacity:1.0 };
var localLabel = null;          // 로컬모드 선택 구역 라벨 오버레이
var selectedFeatureName = null; // 현재 선택 구역 표시명
var selectedFeatureId = null;   // 폰 미러용 선택 구역 식별자
var colorControls = [];         // 색상 트리거 재도색용 레지스트리

/* ========== 폰 미러 (모바일 미리보기) ========== */
var phoneMap = null;            // 폰 프레임 내 2번째 지도
var phoneZoneOverlays = [];     // 폰 지도의 존 오버레이 [{polygons,label}]
var phoneLocalLabel = null;     // 폰 지도의 로컬 선택 라벨
var phoneViewportRect = null;   // 관리자 지도에 표시하는 폰 뷰포트 사각형
var phoneCenterMarker = null;   // 폰 중심 마커
var phoneViewportOn = true;     // 폰 표시영역 오버레이 온오프
var dongIndex = null;           // 동 point-in-polygon 인덱스 [{name,bbox,polys}]
function featKey(f){return f.getProperty('adm_cd')||f.getProperty('adm_nm')||null;}

/* ========== 로컬 스타일 ========== */
function getDefaultStyle() {
  return { strokeColor:styleConfig.default.strokeColor, strokeWeight:Number(styleConfig.default.strokeWeight),
    strokeOpacity:Number(styleConfig.default.strokeOpacity), fillColor:styleConfig.default.fillColor,
    fillOpacity:Number(styleConfig.default.fillOpacity), cursor:'pointer' };
}
function getHighlightStyle() {
  return { strokeColor:styleConfig.highlight.strokeColor, strokeWeight:Number(styleConfig.highlight.strokeWeight),
    strokeOpacity:Number(styleConfig.highlight.strokeOpacity), fillColor:styleConfig.highlight.fillColor,
    fillOpacity:Number(styleConfig.highlight.fillOpacity) };
}
function refreshMapStyles() {
  if (!map) return;
  // hover 시 overrideStyle로 남는 스타일이 setStyle보다 우선시돼 설정 변경이 반영 안 되는 문제 방지
  map.data.revertStyle();
  map.data.setStyle(function(f) { return f === selectedFeature ? getHighlightStyle() : getDefaultStyle(); });
  refreshPhoneMapStyles();
}

/* ========== 스무딩 (0~1 강도) ========== */
function chaikinSmooth(coords, factor) {
  // factor 0~1: 0=원본, 1=최대 스무딩
  if (factor <= 0) return coords;
  var iterations = Math.max(1, Math.round(factor * 5));
  var p = coords.slice();
  for (var t = 0; t < iterations; t++) {
    var np = [], l = p.length - 1;
    for (var i = 0; i < l; i++) {
      var a=p[i], b=p[(i+1)%l];
      var r = 0.25 * factor; // 부드러움 비율
      var s = 1 - r;
      np.push([a[0]*s+b[0]*r, a[1]*s+b[1]*r]);
      np.push([a[0]*r+b[0]*s, a[1]*r+b[1]*s]);
    }
    np.push(np[0].slice()); p = np;
  }
  return p;
}
function smoothGeoJson(gj, factor) {
  var c = JSON.parse(JSON.stringify(gj));
  c.features.forEach(function(f) {
    var g = f.geometry;
    if (g.type==='Polygon') g.coordinates = g.coordinates.map(function(r){return chaikinSmooth(r,factor);});
    else if (g.type==='MultiPolygon') g.coordinates = g.coordinates.map(function(p){return p.map(function(r){return chaikinSmooth(r,factor);});});
  });
  return c;
}
function applyGeoJsonToMap() {
  if (!map||!originalGeoJson) return;
  selectedFeature = null; selectedFeatureName = null; selectedFeatureId = null; updateInfoPanel(null); removeLocalLabel();
  map.data.forEach(function(f){map.data.remove(f);});
  map.data.addGeoJson(smoothEnabled ? smoothGeoJson(originalGeoJson,smoothIntensity) : originalGeoJson);
  refreshMapStyles();
  buildDongIndex();
  applyGeoJsonToPhone(); phoneDataVisibility(); updatePhoneUI(); updatePhoneLocation(); updatePhoneViewportOverlay();
}

/* ========== 헥사곤 유틸 ========== */
function getHexGridParams(radius) {
  var r = radius || hexRadiusKm;
  var R_lat = r / 111.32;
  var R_lng = r / (111.32 * Math.cos(REF_LAT_RAD));
  return { R_lat:R_lat, R_lng:R_lng, colSpacing:1.5*R_lng, rowSpacing:Math.sqrt(3)*R_lat };
}
function hexVertices(cx, cy, R_lat, R_lng) {
  var pts = [];
  for (var i = 0; i < 6; i++) {
    var a = i * Math.PI / 3;
    pts.push({ lat: cy + R_lat * Math.sin(a), lng: cx + R_lng * Math.cos(a) });
  }
  return pts;
}
function centerToHexId(lat, lng, gp) {
  if (!gp) gp = getHexGridParams();
  var col = Math.round(lng / gp.colSpacing);
  var isOdd = ((col % 2) + 2) % 2 === 1;
  var row = Math.round((lat - (isOdd ? gp.rowSpacing / 2 : 0)) / gp.rowSpacing);
  return { col: col, row: row, id: col + '_' + row };
}
function hexCenterFromColRow(col, row, gp) {
  if (!gp) gp = getHexGridParams();
  var isOdd = ((col % 2) + 2) % 2 === 1;
  return { lng: col * gp.colSpacing, lat: row * gp.rowSpacing + (isOdd ? gp.rowSpacing / 2 : 0) };
}

/* ========== 고정 그리드 ========== */
function generateHexagons() {
  clearHexagons();
  if (!map) return;
  var bounds = map.getBounds();
  if (!bounds) return;
  var ne = bounds.getNorthEast(), sw = bounds.getSouthWest();
  var gp = getHexGridParams();
  var startCol = Math.floor(sw.lng()/gp.colSpacing) - 1, endCol = Math.ceil(ne.lng()/gp.colSpacing) + 1;
  var startRow = Math.floor(sw.lat()/gp.rowSpacing) - 1, endRow = Math.ceil(ne.lat()/gp.rowSpacing) + 1;
  var count = 0, MAX = 2500;
  for (var col = startCol; col <= endCol && count < MAX; col++) {
    var isOdd = ((col % 2) + 2) % 2 === 1;
    for (var row = startRow; row <= endRow && count < MAX; row++) {
      var cx = col * gp.colSpacing;
      var cy = row * gp.rowSpacing + (isOdd ? gp.rowSpacing / 2 : 0);
      var hexId = col + '_' + row;
      if (isHexInNonEditingZone(cx, cy)) continue;
      var isSel = selectedHexes.has(hexId);
      var paths = hexVertices(cx, cy, gp.R_lat, gp.R_lng);
      var poly = new google.maps.Polygon({
        paths: paths,
        fillColor: isSel ? hexStyleConfig.selected.fillColor : hexStyleConfig.default.fillColor,
        fillOpacity: isSel ? Number(hexStyleConfig.selected.fillOpacity) : Number(hexStyleConfig.default.fillOpacity),
        strokeColor: isSel ? hexStyleConfig.selected.strokeColor : hexStyleConfig.default.strokeColor,
        strokeWeight: isSel ? Number(hexStyleConfig.selected.strokeWeight) : Number(hexStyleConfig.default.strokeWeight),
        strokeOpacity: isSel ? Number(hexStyleConfig.selected.strokeOpacity) : Number(hexStyleConfig.default.strokeOpacity),
        clickable: true, zIndex: isSel ? 2 : 1,
      });
      poly.hexId = hexId; poly._col = col; poly._row = row; poly._cx = cx; poly._cy = cy;
      poly.setMap(map);
      poly.addListener('click', (function(p){return function(){toggleHex(p);};})(poly));
      poly.addListener('mouseover', (function(p,id){return function(){
        if(!selectedHexes.has(id)) p.setOptions({fillOpacity:Number(hexStyleConfig.default.fillOpacity)+0.1,strokeWeight:2});
      };})(poly,hexId));
      poly.addListener('mouseout', (function(p,id){return function(){
        if(!selectedHexes.has(id)) p.setOptions({fillOpacity:Number(hexStyleConfig.default.fillOpacity),strokeWeight:Number(hexStyleConfig.default.strokeWeight)});
      };})(poly,hexId));
      hexPolygons.push(poly); count++;
    }
  }
  updateTrendInfo();
}

function isHexInNonEditingZone(cx, cy) {
  var th = 0.0001;
  for (var i = 0; i < trendZones.length; i++) {
    var z = trendZones[i]; if (z.id === editingZoneId) continue;
    for (var j = 0; j < z.hexCenters.length; j++) {
      if (Math.abs(z.hexCenters[j].lat - cy) < th && Math.abs(z.hexCenters[j].lng - cx) < th) return true;
    }
  }
  return false;
}

function toggleHex(poly) {
  if(currentRole && currentRole!=='admin') return; // 데모유저는 존 편집 불가
  var id = poly.hexId;
  if (selectedHexes.has(id)) {
    selectedHexes.delete(id);
    poly.setOptions({ fillColor:hexStyleConfig.default.fillColor, fillOpacity:Number(hexStyleConfig.default.fillOpacity),
      strokeColor:hexStyleConfig.default.strokeColor, strokeWeight:Number(hexStyleConfig.default.strokeWeight),
      strokeOpacity:Number(hexStyleConfig.default.strokeOpacity), zIndex:1 });
  } else {
    selectedHexes.set(id, { col:poly._col, row:poly._row, lat:poly._cy, lng:poly._cx });
    poly.setOptions({ fillColor:hexStyleConfig.selected.fillColor, fillOpacity:Number(hexStyleConfig.selected.fillOpacity),
      strokeColor:hexStyleConfig.selected.strokeColor, strokeWeight:Number(hexStyleConfig.selected.strokeWeight),
      strokeOpacity:Number(hexStyleConfig.selected.strokeOpacity), zIndex:2 });
  }
  updateTrendInfo(); updateZoneSaveUI();
}

function clearHexagons() { hexPolygons.forEach(function(p){p.setMap(null);}); hexPolygons = []; }
function clearHexSelection() { selectedHexes.clear(); refreshHexStyles(); updateTrendInfo(); updateZoneSaveUI(); }

function refreshHexStyles() {
  hexPolygons.forEach(function(p) {
    var s = selectedHexes.has(p.hexId);
    p.setOptions({
      fillColor: s?hexStyleConfig.selected.fillColor:hexStyleConfig.default.fillColor,
      fillOpacity: s?Number(hexStyleConfig.selected.fillOpacity):Number(hexStyleConfig.default.fillOpacity),
      strokeColor: s?hexStyleConfig.selected.strokeColor:hexStyleConfig.default.strokeColor,
      strokeWeight: s?Number(hexStyleConfig.selected.strokeWeight):Number(hexStyleConfig.default.strokeWeight),
      strokeOpacity: s?Number(hexStyleConfig.selected.strokeOpacity):Number(hexStyleConfig.default.strokeOpacity),
      zIndex: s?2:1,
    });
  });
}

function updateTrendInfo() {
  var el = document.getElementById('info-text');
  var c = selectedHexes.size;
  if (editingZoneId) {
    var zone = trendZones.find(function(z){return z.id===editingZoneId;});
    el.innerHTML = '<span class="editing-badge">편집 중</span> ' + (zone?escHtml(zone.name):'') +
      '<br/><span class="hex-info">헥사곤: '+c+'개 · 클릭으로 추가/제거</span>';
  } else if (c===0) {
    el.innerHTML = '헥사곤을 클릭하여 영역을 선택하세요.<br/><span class="hex-info">복수 선택 가능</span>';
  } else {
    el.innerHTML = '선택된 헥사곤: <span class="dong-name" style="background:rgba(255,152,0,0.15);color:#ffb74d;">'+c+'개</span>';
  }
}

function updateZoneSaveUI() {
  var area = document.getElementById('zone-save-area');
  var editBar = document.getElementById('zone-edit-bar');
  if (editingZoneId) {
    area.style.display = 'none'; editBar.style.display = '';
    var zone = trendZones.find(function(z){return z.id===editingZoneId;});
    document.getElementById('zone-edit-label').textContent = (zone?zone.name:'')+' 편집 중';
    document.getElementById('zone-edit-color').value = zone?zone.color:'#ff9800';
  } else {
    editBar.style.display = 'none';
    if (currentMode==='trend'&&selectedHexes.size>0) { area.style.display=''; }
    else { area.style.display='none'; document.getElementById('zone-form').style.display='none'; document.getElementById('zone-save-btn').style.display=''; }
  }
}

/* ========== 색상 유틸 ========== */
function hexToRgb(hex){hex=(hex||'#000000').replace('#','');if(hex.length===3)hex=hex.split('').map(function(c){return c+c;}).join('');return {r:parseInt(hex.slice(0,2),16),g:parseInt(hex.slice(2,4),16),b:parseInt(hex.slice(4,6),16)};}
function hexToRgba(hex,a){var c=hexToRgb(hex);return 'rgba('+c.r+','+c.g+','+c.b+','+(a==null?1:a)+')';}
function mergeInto(target,src){if(target&&src)Object.keys(src).forEach(function(k){target[k]=src[k];});}

/* ========== 커스텀 라벨 오버레이 (범용) ========== */
function MapLabel(pos,text,style,m){this.position=pos;this.text=text;this.style=style||{};this.div=null;this.setMap(m);}
function initMapLabelClass(){
  MapLabel.prototype=new google.maps.OverlayView();
  MapLabel.prototype._apply=function(d){var s=this.style||{};if(s.bg)d.style.backgroundColor=s.bg;if(s.color)d.style.color=s.color;if(s.fontSize)d.style.fontSize=s.fontSize+'px';};
  MapLabel.prototype.onAdd=function(){var d=document.createElement('div');d.className='map-label-tag';this._apply(d);d.textContent=this.text;this.div=d;this.getPanes().overlayMouseTarget.appendChild(d);};
  MapLabel.prototype.updateStyle=function(style){this.style=style||{};if(this.div)this._apply(this.div);};
  MapLabel.prototype.draw=function(){var p=this.getProjection();if(!p)return;var pos=p.fromLatLngToDivPixel(this.position);if(this.div&&pos){this.div.style.left=pos.x+'px';this.div.style.top=pos.y+'px';}};
  MapLabel.prototype.onRemove=function(){if(this.div&&this.div.parentNode){this.div.parentNode.removeChild(this.div);this.div=null;}};
}

/* ========== 로컬모드 선택 라벨 ========== */
function featureCentroid(feature){try{var b=new google.maps.LatLngBounds();feature.getGeometry().forEachLatLng(function(ll){b.extend(ll);});return b.getCenter();}catch(e){return null;}}
function localLabelStyle(){return {bg:hexToRgba(localLabelConfig.bgColor,Number(localLabelConfig.bgOpacity)),color:localLabelConfig.textColor,fontSize:Number(localLabelConfig.fontSize)};}
function showLocalLabel(){
  removeLocalLabel();
  if(currentMode!=='local'||!localLabelConfig.enabled||!selectedFeature)return;
  var c=featureCentroid(selectedFeature);if(!c)return;
  localLabel=new MapLabel(c,selectedFeatureName||'',localLabelStyle(),map);
  if(phoneMap)phoneLocalLabel=new MapLabel(c,selectedFeatureName||'',localLabelStyle(),phoneMap);
}
function removeLocalLabel(){if(localLabel){localLabel.setMap(null);localLabel=null;}if(phoneLocalLabel){phoneLocalLabel.setMap(null);phoneLocalLabel=null;}}
function updateLocalLabelStyle(){if(localLabel){localLabel.updateStyle(localLabelStyle());if(phoneLocalLabel)phoneLocalLabel.updateStyle(localLabelStyle());}else showLocalLabel();}

/* ========== 존 라벨 스타일 ========== */
function zoneLabelStyle(zoneColor){return {bg:hexToRgba(zoneColor,Number(zoneLabelConfig.bgOpacity)),color:zoneLabelConfig.textColor,fontSize:Number(zoneLabelConfig.fontSize)};}
function refreshZoneLabels(){trendZones.forEach(function(z){if(z.label)z.label.updateStyle(zoneLabelStyle(z.color));});refreshPhoneZoneLabels();}

/* ========== 폰 미러 (모바일 미리보기) ========== */
function initPhoneMirror(){
  var el=document.getElementById('phone-map');if(!el||typeof google==='undefined')return;
  var isMobile=window.matchMedia('(max-width:768px)').matches;
  var opts={center:{lat:CONFIG.MAP_CENTER_LAT,lng:CONFIG.MAP_CENTER_LNG},zoom:CONFIG.MAP_ZOOM,
    disableDefaultUI:true,gestureHandling:isMobile?'greedy':'none',keyboardShortcuts:false,clickableIcons:false};
  if(CONFIG.MAP_ID&&CONFIG.MAP_ID.length>0)opts.mapId=CONFIG.MAP_ID;else opts.styles=mapStyles();
  phoneMap=new google.maps.Map(el,opts);
  // 카메라 단방향 미러 (PC → 폰)
  var sync=function(){if(!phoneMap)return;var c=map.getCenter();if(c)phoneMap.setCenter(c);phoneMap.setZoom(map.getZoom());};
  map.addListener('center_changed',sync);
  map.addListener('zoom_changed',sync);
  map.addListener('idle',function(){sync();updatePhoneLocation();updatePhoneViewportOverlay();});
  phoneMap.addListener('idle',function(){updatePhoneViewportOverlay();});
  sync();
  if(originalGeoJson){buildDongIndex();applyGeoJsonToPhone();}
  phoneDataVisibility();syncPhoneZones();updatePhoneUI();updatePhoneLocation();updatePhoneViewportOverlay();
}
function applyGeoJsonToPhone(){
  if(!phoneMap||!originalGeoJson)return;
  phoneMap.data.forEach(function(f){phoneMap.data.remove(f);});
  phoneMap.data.addGeoJson(smoothEnabled?smoothGeoJson(originalGeoJson,smoothIntensity):originalGeoJson);
  refreshPhoneMapStyles();
}
function refreshPhoneMapStyles(){
  if(!phoneMap)return;
  phoneMap.data.setStyle(function(f){return featKey(f)===selectedFeatureId?getHighlightStyle():getDefaultStyle();});
}
function phoneDataVisibility(){if(phoneMap)phoneMap.data.setMap(currentMode==='local'?phoneMap:null);}
function syncPhoneZones(){
  if(!phoneMap)return;
  phoneZoneOverlays.forEach(function(o){o.polygons.forEach(function(p){p.setMap(null);});if(o.label)o.label.setMap(null);});
  phoneZoneOverlays=[];
  if(currentMode!=='trend')return;
  trendZones.forEach(function(zone){
    if(zone.id===editingZoneId)return;
    var gp=getHexGridParams(zone.radiusKm),polys=[],sumLat=0,sumLng=0;
    zone.hexCenters.forEach(function(c){
      var poly=new google.maps.Polygon({paths:hexVertices(c.lng,c.lat,gp.R_lat,gp.R_lng),fillColor:zone.color,fillOpacity:0.35,strokeColor:zone.color,strokeWeight:2,strokeOpacity:0.8,clickable:false,zIndex:3});
      poly.setMap(phoneMap);polys.push(poly);sumLat+=c.lat;sumLng+=c.lng;
    });
    var label=null;
    if(zone.hexCenters.length>0)label=new MapLabel(new google.maps.LatLng(sumLat/zone.hexCenters.length,sumLng/zone.hexCenters.length),zone.name,zoneLabelStyle(zone.color),phoneMap);
    phoneZoneOverlays.push({polygons:polys,label:label,color:zone.color});
  });
}
function refreshPhoneZoneLabels(){phoneZoneOverlays.forEach(function(o){if(o.label)o.label.updateStyle(zoneLabelStyle(o.color));});}

/* ========== 동 위치 판별 (point-in-polygon) ========== */
function buildDongIndex(){
  if(!originalGeoJson)return;
  dongIndex=originalGeoJson.features.map(function(f){
    var g=f.geometry,polys=[];
    if(g.type==='Polygon')polys=[g.coordinates];
    else if(g.type==='MultiPolygon')polys=g.coordinates;
    var minx=Infinity,miny=Infinity,maxx=-Infinity,maxy=-Infinity;
    polys.forEach(function(poly){poly[0].forEach(function(pt){if(pt[0]<minx)minx=pt[0];if(pt[0]>maxx)maxx=pt[0];if(pt[1]<miny)miny=pt[1];if(pt[1]>maxy)maxy=pt[1];});});
    var raw=(f.properties&&(f.properties.adm_nm||f.properties.name))||'';
    var p=raw.split(' ');var shortName=p.length>2?p.slice(2).join(' '):raw;
    return {name:shortName,bbox:[minx,miny,maxx,maxy],polys:polys};
  });
}
function pointInRing(x,y,ring){
  var inside=false;
  for(var i=0,j=ring.length-1;i<ring.length;j=i++){
    var xi=ring[i][0],yi=ring[i][1],xj=ring[j][0],yj=ring[j][1];
    if(((yi>y)!==(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi)+xi))inside=!inside;
  }
  return inside;
}
function dongAt(lat,lng){
  if(!dongIndex)return null;
  for(var i=0;i<dongIndex.length;i++){
    var d=dongIndex[i],b=d.bbox;
    if(lng<b[0]||lng>b[2]||lat<b[1]||lat>b[3])continue;
    for(var pI=0;pI<d.polys.length;pI++){
      var poly=d.polys[pI];
      if(pointInRing(lng,lat,poly[0])){
        var inHole=false;
        for(var h=1;h<poly.length;h++){if(pointInRing(lng,lat,poly[h])){inHole=true;break;}}
        if(!inHole)return d.name;
      }
    }
  }
  return null;
}
function updatePhoneLocation(){
  var el=document.getElementById('phone-loc');if(!el)return;
  var nameEl=el.querySelector('.pa-loc-name')||el;
  if(!map){nameEl.textContent='···';return;}
  var c=map.getCenter();if(!c){nameEl.textContent='···';return;}
  var name=dongAt(c.lat(),c.lng());
  nameEl.textContent=name||'위치 확인 중';
}

/* ========== 관리자 지도: 폰 표시영역 오버레이 ========== */
function phoneCollapsed(){var m=document.getElementById('phone-mirror');return m&&m.classList.contains('collapsed');}
function clearPhoneViewportOverlay(){if(phoneViewportRect)phoneViewportRect.setMap(null);if(phoneCenterMarker)phoneCenterMarker.setMap(null);}
function updatePhoneViewportOverlay(){
  if(!map||!phoneMap)return;
  if(!phoneViewportOn||phoneCollapsed()){clearPhoneViewportOverlay();return;}
  var b=phoneMap.getBounds(),c=phoneMap.getCenter();
  if(!b||!c)return;
  if(!phoneViewportRect)phoneViewportRect=new google.maps.Rectangle({fillColor:'#6ec6ff',fillOpacity:0.06,strokeColor:'#6ec6ff',strokeOpacity:0.95,strokeWeight:2,clickable:false,zIndex:60});
  phoneViewportRect.setOptions({bounds:b});phoneViewportRect.setMap(map);
  if(!phoneCenterMarker)phoneCenterMarker=new google.maps.Marker({clickable:false,zIndex:61,icon:{path:google.maps.SymbolPath.CIRCLE,scale:5,fillColor:'#6ec6ff',fillOpacity:1,strokeColor:'#ffffff',strokeWeight:2}});
  phoneCenterMarker.setPosition(c);phoneCenterMarker.setMap(map);
}
function updatePhoneUI(){ updatePhoneLocation(); }

/* ========== 폰 컨트롤 (드래그/크기/접기/네비) ========== */
var phoneWidth=244;
function phoneMirrorEl(){return document.getElementById('phone-mirror');}
function clampPhonePos(x,y){
  var m=phoneMirrorEl();if(!m)return;var r=m.getBoundingClientRect();
  var maxX=Math.max(6,window.innerWidth-r.width-6), maxY=Math.max(6,window.innerHeight-r.height-6);
  x=Math.max(6,Math.min(x,maxX)); y=Math.max(6,Math.min(y,maxY));
  m.style.left=x+'px';m.style.top=y+'px';m.style.right='auto';m.style.transform='none';
}
function reclampPhone(){var m=phoneMirrorEl();if(!m||!m.style.left)return;var r=m.getBoundingClientRect();clampPhonePos(r.left,r.top);}
function phoneResizeMap(){if(!phoneMap)return;setTimeout(function(){google.maps.event.trigger(phoneMap,'resize');var c=map&&map.getCenter();if(c)phoneMap.setCenter(c);if(map)phoneMap.setZoom(map.getZoom());},90);}
function setPhoneWidth(w){
  phoneWidth=Math.max(224,Math.min(360,w));
  var m=phoneMirrorEl();if(m)m.style.setProperty('--phone-w',phoneWidth+'px');
  reclampPhone();phoneResizeMap();
}
function initPhoneControls(){
  var mirror=phoneMirrorEl();if(!mirror)return;
  // 접기/펼치기
  var tg=document.getElementById('phone-toggle');
  if(tg)tg.addEventListener('click',function(){
    var c=mirror.classList.toggle('collapsed');
    tg.setAttribute('aria-expanded',c?'false':'true');
    tg.setAttribute('aria-label',c?'모바일 미리보기 펼치기':'모바일 미리보기 접기');
    tg.setAttribute('title',c?'모바일 미리보기 펼치기':'모바일 미리보기 접기');
    if(!c){reclampPhone();phoneResizeMap();}
    updatePhoneViewportOverlay();
  });
  // 크기 조절
  var bg=document.getElementById('phone-bigger'),sm=document.getElementById('phone-smaller');
  if(bg)bg.addEventListener('click',function(){setPhoneWidth(phoneWidth+22);});
  if(sm)sm.addEventListener('click',function(){setPhoneWidth(phoneWidth-22);});
  // 드래그 이동 (화면 밖으로 나가지 않도록 clamp)
  var handle=document.getElementById('phone-drag');
  var dragging=false,sx,sy,ox,oy;
  function pt(e){return e.touches&&e.touches[0]?e.touches[0]:e;}
  function down(e){dragging=true;var r=mirror.getBoundingClientRect();var p=pt(e);sx=p.clientX;sy=p.clientY;ox=r.left;oy=r.top;
    mirror.classList.add('dragging');if(e.cancelable)e.preventDefault();
    document.addEventListener('mousemove',move);document.addEventListener('mouseup',up);
    document.addEventListener('touchmove',move,{passive:false});document.addEventListener('touchend',up);}
  function move(e){if(!dragging)return;var p=pt(e);clampPhonePos(ox+(p.clientX-sx),oy+(p.clientY-sy));if(e.cancelable)e.preventDefault();}
  function up(){dragging=false;mirror.classList.remove('dragging');
    document.removeEventListener('mousemove',move);document.removeEventListener('mouseup',up);
    document.removeEventListener('touchmove',move);document.removeEventListener('touchend',up);}
  if(handle){handle.addEventListener('mousedown',down);handle.addEventListener('touchstart',down,{passive:false});}
  // 하단 네비 활성 전환
  mirror.querySelectorAll('.pn-item').forEach(function(b){b.addEventListener('click',function(){
    mirror.querySelectorAll('.pn-item').forEach(function(x){x.classList.remove('active');});b.classList.add('active');
  });});
  // 창 크기 변경 시 화면 밖 방지
  window.addEventListener('resize',reclampPhone);
}

/* ========== 트렌드 존 CRUD ========== */
function saveTrendZone(name, color) {
  var centers = [];
  selectedHexes.forEach(function(d){centers.push({id:d.col+'_'+d.row,lat:d.lat,lng:d.lng});});
  var zone = {id:'tz_'+Date.now(),name:name,color:color,radiusKm:hexRadiusKm,
    hexCenters:centers,
    originalCenters:JSON.parse(JSON.stringify(centers)),
    originalRadiusKm:hexRadiusKm,
    polygons:[],label:null};
  trendZones.push(zone);
  renderZoneOnMap(zone); selectedHexes.clear(); generateHexagons();
  updateTrendInfo(); updateZoneSaveUI(); renderZoneList(); saveZonesToStorage();
}

function renderZoneOnMap(zone) {
  removeZoneFromMap(zone);
  if (currentMode!=='trend') return;
  var gp = getHexGridParams(zone.radiusKm);
  var sumLat=0, sumLng=0;
  zone.hexCenters.forEach(function(c){
    var paths=hexVertices(c.lng,c.lat,gp.R_lat,gp.R_lng);
    var poly=new google.maps.Polygon({paths:paths,fillColor:zone.color,fillOpacity:0.35,strokeColor:zone.color,strokeWeight:2,strokeOpacity:0.8,clickable:false,zIndex:3});
    poly.setMap(map); zone.polygons.push(poly);
    sumLat+=c.lat; sumLng+=c.lng;
  });
  if (zone.hexCenters.length>0) {
    zone.label=new MapLabel(new google.maps.LatLng(sumLat/zone.hexCenters.length,sumLng/zone.hexCenters.length),zone.name,zoneLabelStyle(zone.color),map);
  }
}

function removeZoneFromMap(zone){zone.polygons.forEach(function(p){p.setMap(null);});zone.polygons=[];if(zone.label){zone.label.setMap(null);zone.label=null;}}
function showAllZonesOnMap(){trendZones.forEach(function(z){if(z.id!==editingZoneId&&z.polygons.length===0) renderZoneOnMap(z);});}
function hideAllZonesFromMap(){trendZones.forEach(function(z){removeZoneFromMap(z);});}

function deleteZone(zoneId){
  var idx=trendZones.findIndex(function(z){return z.id===zoneId;});
  if(idx<0) return; if(editingZoneId===zoneId) cancelEditZone();
  removeZoneFromMap(trendZones[idx]); trendZones.splice(idx,1);
  renderZoneList(); if(currentMode==='trend') generateHexagons(); saveZonesToStorage();
}

function updateZone(zoneId,newName,newColor){
  var zone=trendZones.find(function(z){return z.id===zoneId;});
  if(!zone) return; zone.name=newName; zone.color=newColor;
  renderZoneOnMap(zone); renderZoneList(); saveZonesToStorage();
}

/* ========== 반경 변경 시 존 재그리드 (원본 기준) ========== */
function rezoneAllToCurrentRadius() {
  var newGp = getHexGridParams();
  trendZones.forEach(function(zone) {
    if (zone.radiusKm === hexRadiusKm) return;
    // 항상 원본 데이터 기준으로 재계산
    var origCenters = zone.originalCenters || zone.hexCenters;
    var origRadius = zone.originalRadiusKm || zone.radiusKm;
    var oldGp = getHexGridParams(origRadius);
    var newHexMap = new Map();

    origCenters.forEach(function(oc) {
      var searchC = Math.ceil(oldGp.R_lng / newGp.colSpacing) + 2;
      var searchR = Math.ceil(oldGp.R_lat / newGp.rowSpacing) + 2;
      var ac = Math.round(oc.lng / newGp.colSpacing);
      var ar = Math.round(oc.lat / newGp.rowSpacing);
      for (var dc = -searchC; dc <= searchC; dc++) {
        for (var dr = -searchR; dr <= searchR; dr++) {
          var nc = hexCenterFromColRow(ac+dc, ar+dr, newGp);
          var dl = nc.lat - oc.lat, dn = nc.lng - oc.lng;
          if (Math.sqrt((dl/oldGp.R_lat)*(dl/oldGp.R_lat)+(dn/oldGp.R_lng)*(dn/oldGp.R_lng)) <= 1.0) {
            var hid = (ac+dc)+'_'+(ar+dr);
            if (!newHexMap.has(hid)) newHexMap.set(hid, {id:hid, lat:nc.lat, lng:nc.lng});
          }
        }
      }
    });

    zone.hexCenters = Array.from(newHexMap.values());
    zone.radiusKm = hexRadiusKm;
    removeZoneFromMap(zone);
    if (currentMode==='trend') renderZoneOnMap(zone);
  });
  renderZoneList(); saveZonesToStorage();
}

/* ========== 존 편집 ========== */
function startEditZone(zoneId) {
  var zone=trendZones.find(function(z){return z.id===zoneId;});
  if(!zone) return;
  selectedHexes.clear(); editingZoneId=zoneId;
  editingZoneBackup={hexCenters:JSON.parse(JSON.stringify(zone.hexCenters)),color:zone.color,
    originalCenters:zone.originalCenters?JSON.parse(JSON.stringify(zone.originalCenters)):null,
    originalRadiusKm:zone.originalRadiusKm};

  if (zone.radiusKm !== hexRadiusKm) {
    var oldGp=getHexGridParams(zone.radiusKm); var newGp=getHexGridParams();
    var origCenters=zone.originalCenters||zone.hexCenters;
    var origRadius=zone.originalRadiusKm||zone.radiusKm;
    var origGp=getHexGridParams(origRadius);
    var newHexMap=new Map();
    origCenters.forEach(function(oc){
      var sC=Math.ceil(origGp.R_lng/newGp.colSpacing)+2;
      var sR=Math.ceil(origGp.R_lat/newGp.rowSpacing)+2;
      var ac=Math.round(oc.lng/newGp.colSpacing);var ar=Math.round(oc.lat/newGp.rowSpacing);
      for(var dc=-sC;dc<=sC;dc++){for(var dr=-sR;dr<=sR;dr++){
        var nc=hexCenterFromColRow(ac+dc,ar+dr,newGp);
        var dl=nc.lat-oc.lat,dn=nc.lng-oc.lng;
        if(Math.sqrt((dl/origGp.R_lat)*(dl/origGp.R_lat)+(dn/origGp.R_lng)*(dn/origGp.R_lng))<=1.0){
          var hid=(ac+dc)+'_'+(ar+dr);
          if(!newHexMap.has(hid)) newHexMap.set(hid,{id:hid,lat:nc.lat,lng:nc.lng});
        }
      }}
    });
    zone.hexCenters=Array.from(newHexMap.values()); zone.radiusKm=hexRadiusKm;
  }

  zone.hexCenters.forEach(function(c){
    var h=centerToHexId(c.lat,c.lng);
    selectedHexes.set(h.id,{col:h.col,row:h.row,lat:c.lat,lng:c.lng});
  });
  removeZoneFromMap(zone); generateHexagons();
  updateTrendInfo(); updateZoneSaveUI(); renderZoneList();
}

function finishEditZone() {
  var zone=trendZones.find(function(z){return z.id===editingZoneId;});
  if(!zone){cancelEditZone();return;}
  var centers=[];
  selectedHexes.forEach(function(d){centers.push({id:d.col+'_'+d.row,lat:d.lat,lng:d.lng});});
  zone.hexCenters=centers; zone.radiusKm=hexRadiusKm;
  zone.color=document.getElementById('zone-edit-color').value;
  // 편집 시 원본도 갱신 (사용자가 수동 편집한 것이므로)
  zone.originalCenters=JSON.parse(JSON.stringify(centers));
  zone.originalRadiusKm=hexRadiusKm;
  editingZoneId=null; editingZoneBackup=null; selectedHexes.clear();
  renderZoneOnMap(zone); generateHexagons();
  updateTrendInfo(); updateZoneSaveUI(); renderZoneList(); saveZonesToStorage();
}

function cancelEditZone() {
  var zone=trendZones.find(function(z){return z.id===editingZoneId;});
  if(zone&&editingZoneBackup){
    zone.hexCenters=editingZoneBackup.hexCenters; zone.color=editingZoneBackup.color;
    if(editingZoneBackup.originalCenters) zone.originalCenters=editingZoneBackup.originalCenters;
    if(editingZoneBackup.originalRadiusKm) zone.originalRadiusKm=editingZoneBackup.originalRadiusKm;
    renderZoneOnMap(zone);
  }
  editingZoneId=null; editingZoneBackup=null; selectedHexes.clear();
  generateHexagons(); updateTrendInfo(); updateZoneSaveUI(); renderZoneList();
}

/* ========== 존 리스트 UI ========== */
function renderZoneList() {
  syncPhoneZones(); updatePhoneUI();
  var area=document.getElementById('zone-list-area');
  var list=document.getElementById('zone-list'); list.innerHTML='';
  if(trendZones.length===0||currentMode!=='trend'){area.style.display='none';return;}
  area.style.display='';
  trendZones.forEach(function(zone){
    var isEd=zone.id===editingZoneId;
    var item=document.createElement('div');
    item.className='zone-item'+(isEd?' editing':'');
    item.innerHTML='<span class="zone-swatch" style="background:'+zone.color+'"></span>'+
      '<span class="zone-name-text">'+escHtml(zone.name)+'</span>'+
      '<span class="zone-count">'+zone.hexCenters.length+'</span>'+
      '<button class="zone-act" data-act="focus" title="이동">📍</button>'+
      '<button class="zone-act" data-act="edit" title="수정">✏️</button>'+
      '<button class="zone-act" data-act="delete" title="삭제">🗑️</button>';
    item.querySelector('[data-act="focus"]').addEventListener('click',function(){focusZone(zone.id);});
    item.querySelector('[data-act="edit"]').addEventListener('click',function(){
      if(editingZoneId===zone.id)return;if(editingZoneId)finishEditZone();startEditZone(zone.id);
    });
    item.querySelector('[data-act="delete"]').addEventListener('click',function(){deleteZone(zone.id);});
    if(!isEd) item.querySelector('.zone-name-text').addEventListener('dblclick',function(){showInlineEdit(zone.id,item);});
    list.appendChild(item);
  });
}

function showInlineEdit(zoneId,itemEl){
  var zone=trendZones.find(function(z){return z.id===zoneId;});if(!zone)return;
  if(itemEl.querySelector('.zone-inline-edit')){itemEl.querySelector('.zone-inline-edit').remove();return;}
  var form=document.createElement('div');form.className='zone-inline-edit';
  form.innerHTML='<input type="text" class="zi-name" value="'+escHtml(zone.name)+'" maxlength="20" /><div class="zone-form-row"><input type="color" class="zi-color" value="'+zone.color+'" /><button class="action-btn accent small">적용</button><button class="action-btn small">닫기</button></div>';
  form.querySelector('.action-btn.accent').addEventListener('click',function(){var n=form.querySelector('.zi-name').value.trim(),c=form.querySelector('.zi-color').value;if(n)updateZone(zoneId,n,c);});
  form.querySelector('.action-btn:not(.accent)').addEventListener('click',function(){form.remove();});
  itemEl.appendChild(form);form.querySelector('.zi-name').focus();
}

function focusZone(zoneId){
  var zone=trendZones.find(function(z){return z.id===zoneId;});if(!zone||!zone.hexCenters.length)return;
  var b=new google.maps.LatLngBounds();zone.hexCenters.forEach(function(c){b.extend({lat:c.lat,lng:c.lng});});map.fitBounds(b,80);
}

function escHtml(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML;}

/* ========== JSON 내보내기/불러오기 ========== */
function exportZones() {
  var data = trendZones.map(function(z){
    return {name:z.name,color:z.color,radiusKm:z.radiusKm,hexCenters:z.hexCenters,
      originalCenters:z.originalCenters,originalRadiusKm:z.originalRadiusKm};
  });
  var payload = {
    version: 2,
    zones: data,
    settings: {
      styleConfig: styleConfig,
      hexStyleConfig: hexStyleConfig,
      smoothEnabled: smoothEnabled,
      smoothIntensity: smoothIntensity,
      hexRadiusKm: hexRadiusKm,
      localLabelConfig: localLabelConfig,
      zoneLabelConfig: zoneLabelConfig
    },
    exportedAt: new Date().toISOString()
  };
  var json = JSON.stringify(payload, null, 2);
  var blob = new Blob([json], {type:'application/json'});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = 'trend-zones-'+new Date().toISOString().slice(0,10)+'.json';
  a.click(); URL.revokeObjectURL(url);
}

function importZones(file) {
  var reader = new FileReader();
  reader.onload = function(e) {
    try {
      var data = JSON.parse(e.target.result);
      var zones = data.zones || data;
      if (!Array.isArray(zones)) { alert('올바른 JSON 형식이 아닙니다.'); return; }
      
      if (data.settings) {
        var s = data.settings;
        // 객체 참조를 유지하기 위해 재할당이 아닌 병합(makeColorControl/bindInput 클로저가 참조를 캡처하므로)
        if(s.styleConfig){ mergeInto(styleConfig.default,s.styleConfig.default); mergeInto(styleConfig.highlight,s.styleConfig.highlight); }
        if(s.hexStyleConfig){ mergeInto(hexStyleConfig.default,s.hexStyleConfig.default); mergeInto(hexStyleConfig.selected,s.hexStyleConfig.selected); }
        if(s.smoothEnabled !== undefined) smoothEnabled = s.smoothEnabled;
        if(s.smoothIntensity !== undefined) smoothIntensity = s.smoothIntensity;
        if(s.hexRadiusKm !== undefined) hexRadiusKm = s.hexRadiusKm;
        if(s.localLabelConfig) mergeInto(localLabelConfig,s.localLabelConfig);
        if(s.zoneLabelConfig) mergeInto(zoneLabelConfig,s.zoneLabelConfig);

        syncSettingsUI();
        refreshMapStyles();
        refreshHexStyles();
        applyGeoJsonToMap();
        refreshZoneLabels();
        updateLocalLabelStyle();
      }

      zones.forEach(function(d) {
        var zone = {id:'tz_'+Date.now()+'_'+Math.random().toString(36).slice(2,6),
          name:d.name, color:d.color, radiusKm:d.radiusKm||hexRadiusKm,
          hexCenters:d.hexCenters,
          originalCenters:d.originalCenters||JSON.parse(JSON.stringify(d.hexCenters)),
          originalRadiusKm:d.originalRadiusKm||d.radiusKm||hexRadiusKm,
          polygons:[], label:null};
        trendZones.push(zone);
        if(currentMode==='trend') renderZoneOnMap(zone);
      });
      if(currentMode==='trend') generateHexagons();
      renderZoneList(); saveZonesToStorage();
      alert(zones.length+'개 트렌드 존' + (data.settings ? ' 및 셋팅값을' : '을') + ' 불러왔습니다.');
    } catch(err) { alert('파일을 읽을 수 없습니다: '+err.message); }
  };
  reader.readAsText(file);
}

/* ========== localStorage ========== */
function saveZonesToStorage(){
  var data=trendZones.map(function(z){
    return {id:z.id,name:z.name,color:z.color,radiusKm:z.radiusKm,hexCenters:z.hexCenters,
      originalCenters:z.originalCenters,originalRadiusKm:z.originalRadiusKm};
  });
  try{localStorage.setItem('nowhere_trendZones',JSON.stringify(data));}catch(e){}
  markCloudDirty();
}
function loadZonesFromStorage(){
  try{
    var data=JSON.parse(localStorage.getItem('nowhere_trendZones')||'[]');
    data.forEach(function(d){
      trendZones.push({id:d.id,name:d.name,color:d.color,radiusKm:d.radiusKm,hexCenters:d.hexCenters,
        originalCenters:d.originalCenters||JSON.parse(JSON.stringify(d.hexCenters)),
        originalRadiusKm:d.originalRadiusKm||d.radiusKm,
        polygons:[],label:null});
    });
    renderZoneList();
  }catch(e){}
}

/* ========== 모드 전환 ========== */
function switchMode(mode){
  if(mode===currentMode) return; if(editingZoneId) finishEditZone();
  currentMode=mode;
  removeLocalLabel(); selectedFeatureName=null; selectedFeatureId=null;
  document.querySelectorAll('.mode-btn').forEach(function(b){b.classList.toggle('active',b.dataset.mode===mode);});
  document.querySelector('.mode-indicator').classList.toggle('right',mode==='trend');
  document.getElementById('local-settings').style.display=mode==='local'?'':'none';
  document.getElementById('trend-settings').style.display=mode==='trend'?'':'none';
  if(mode==='local'){
    clearHexagons();selectedHexes.clear();
    if(boundsListener){google.maps.event.removeListener(boundsListener);boundsListener=null;}
    hideAllZonesFromMap(); map.data.setMap(map); refreshMapStyles();
    selectedFeature=null; updateInfoPanel(null); updateZoneSaveUI();
    document.getElementById('zone-list-area').style.display='none';
  } else {
    map.data.setMap(null); selectedFeature=null;
    showAllZonesOnMap(); generateHexagons();
    var dt; boundsListener=map.addListener('idle',function(){clearTimeout(dt);dt=setTimeout(function(){if(currentMode==='trend')generateHexagons();},350);});
    updateZoneSaveUI(); renderZoneList();
  }
  phoneDataVisibility(); syncPhoneZones(); updatePhoneUI();
}

/* ========== 초기화 ========== */
function initMap(){
  initMapLabelClass();
  var opts={center:{lat:CONFIG.MAP_CENTER_LAT,lng:CONFIG.MAP_CENTER_LNG},zoom:CONFIG.MAP_ZOOM,disableDefaultUI:false,zoomControl:true,mapTypeControl:false,streetViewControl:false,fullscreenControl:true};
  if(CONFIG.MAP_ID&&CONFIG.MAP_ID.length>0) opts.mapId=CONFIG.MAP_ID; else opts.styles=mapStyles();
  map=new google.maps.Map(document.getElementById('map'),opts);
  fetch(CONFIG.GEOJSON_PATH).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}).then(function(geo){originalGeoJson=geo;applyGeoJsonToMap();fitBoundsToData();loadZonesFromStorage();hideMapLoading();mapReady=true;if(cloudData)applyCloudData(cloudData);}).catch(function(err){hideMapLoading();var el=document.getElementById('info-text');if(el)el.textContent='⚠️ 경계 데이터를 불러오지 못했습니다. ('+err.message+')';});
  refreshMapStyles();
  map.data.addListener('click',function(e){if(currentMode!=='local')return;var f=e.feature;if(selectedFeature===f){selectedFeature=null;selectedFeatureName=null;selectedFeatureId=null;refreshMapStyles();updateInfoPanel(null);removeLocalLabel();updatePhoneUI();return;}selectedFeature=f;var raw=f.getProperty('adm_nm')||f.getProperty('name')||'(이름 없음)';var p=raw.split(' ');selectedFeatureName=p.length>2?p.slice(2).join(' '):raw;selectedFeatureId=featKey(f);refreshMapStyles();updateInfoPanel(selectedFeatureName);showLocalLabel();updatePhoneUI();});
  map.addListener('click',function(){if(currentMode==='local'&&selectedFeature){selectedFeature=null;selectedFeatureName=null;selectedFeatureId=null;refreshMapStyles();updateInfoPanel(null);removeLocalLabel();updatePhoneUI();}});
  map.data.addListener('mouseover',function(e){if(currentMode!=='local'||e.feature===selectedFeature)return;map.data.overrideStyle(e.feature,{strokeWeight:Number(styleConfig.default.strokeWeight)+2,fillOpacity:Number(styleConfig.default.fillOpacity)+0.08});});
  map.data.addListener('mouseout',function(e){if(currentMode!=='local'||e.feature===selectedFeature)return;map.data.revertStyle(e.feature);});
  initSettingsPanel();initModeToggle();initZoneForm();initZoneEditBar();initZoneIO();
  initPhoneMirror();
}

function initModeToggle(){document.querySelectorAll('.mode-btn').forEach(function(b){b.addEventListener('click',function(){switchMode(this.dataset.mode);});});}

function initZoneForm(){
  var saveBtn=document.getElementById('zone-save-btn');var form=document.getElementById('zone-form');var colorInput=document.getElementById('zone-color-input');
  var palette=document.getElementById('zone-palette');
  PALETTE.forEach(function(c){var sw=document.createElement('button');sw.className='palette-swatch';sw.type='button';sw.style.backgroundColor=c;sw.addEventListener('click',function(){colorInput.value=c;palette.querySelectorAll('.palette-swatch').forEach(function(s){s.classList.remove('active');});sw.classList.add('active');});palette.appendChild(sw);});
  saveBtn.addEventListener('click',function(){saveBtn.style.display='none';form.style.display='';document.getElementById('zone-name-input').value='';document.getElementById('zone-name-input').focus();colorInput.value=PALETTE[0];palette.querySelectorAll('.palette-swatch').forEach(function(s,i){s.classList.toggle('active',i===0);});});
  document.getElementById('zone-cancel-btn').addEventListener('click',function(){form.style.display='none';saveBtn.style.display='';});
  document.getElementById('zone-confirm-btn').addEventListener('click',function(){var name=document.getElementById('zone-name-input').value.trim();if(!name){document.getElementById('zone-name-input').focus();return;}saveTrendZone(name,colorInput.value);form.style.display='none';saveBtn.style.display='';});
  document.getElementById('zone-name-input').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('zone-confirm-btn').click();});
  document.getElementById('hex-deselect-btn').addEventListener('click',function(){clearHexSelection();});
}

function initZoneEditBar(){
  document.getElementById('zone-edit-done').addEventListener('click',function(){finishEditZone();});
  document.getElementById('zone-edit-cancel').addEventListener('click',function(){cancelEditZone();});
}

function initZoneIO(){
  document.getElementById('zone-export-btn').addEventListener('click',function(){exportZones();});
  document.getElementById('zone-import-btn').addEventListener('click',function(){document.getElementById('zone-import-file').click();});
  document.getElementById('zone-import-file').addEventListener('change',function(e){if(e.target.files.length>0){importZones(e.target.files[0]);e.target.value='';}});
}

/* ========== 색상 팝업 (HSV 스펙트럼 + 알파 + 헥스 + 프리셋) ========== */
var CP = null;
function clamp01(v){return v<0?0:v>1?1:v;}
function hsvToRgb(h,s,v){h/=360;var i=Math.floor(h*6),f=h*6-i,p=v*(1-s),q=v*(1-f*s),t=v*(1-(1-f)*s),r,g,b;switch(i%6){case 0:r=v;g=t;b=p;break;case 1:r=q;g=v;b=p;break;case 2:r=p;g=v;b=t;break;case 3:r=p;g=q;b=v;break;case 4:r=t;g=p;b=v;break;default:r=v;g=p;b=q;}return {r:Math.round(r*255),g:Math.round(g*255),b:Math.round(b*255)};}
function rgbToHsv(r,g,b){r/=255;g/=255;b/=255;var max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min,h,s=max===0?0:d/max,v=max;if(d===0)h=0;else if(max===r)h=((g-b)/d)%6;else if(max===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60;if(h<0)h+=360;return {h:h,s:s,v:v};}
function rgbToHex(r,g,b){return '#'+[r,g,b].map(function(x){return ('0'+x.toString(16)).slice(-2);}).join('');}
function cpHex(){var c=hsvToRgb(CP.h,CP.s,CP.v);return rgbToHex(c.r,c.g,c.b);}

function buildColorPopup(){
  if(CP)return CP;
  var pop=document.createElement('div');pop.className='color-popup';pop.style.display='none';
  pop.innerHTML=
    '<div class="cp-sv"><div class="cp-thumb cp-sv-thumb"></div></div>'+
    '<div class="cp-slider cp-hue"><div class="cp-thumb cp-hue-thumb"></div></div>'+
    '<div class="cp-slider cp-alpha"><div class="cp-alpha-grad"></div><div class="cp-thumb cp-alpha-thumb"></div></div>'+
    '<div class="cp-inputs"><span class="cp-preview"><i class="cp-fill"></i></span><input class="cp-hex" spellcheck="false" maxlength="7" /><input class="cp-anum" type="number" min="0" max="100" step="1" /><span class="cp-apct">%</span></div>'+
    '<div class="cp-presets"></div>';
  document.body.appendChild(pop);
  CP={el:pop,sv:pop.querySelector('.cp-sv'),svThumb:pop.querySelector('.cp-sv-thumb'),
    hue:pop.querySelector('.cp-hue'),hueThumb:pop.querySelector('.cp-hue-thumb'),
    alpha:pop.querySelector('.cp-alpha'),alphaGrad:pop.querySelector('.cp-alpha-grad'),alphaThumb:pop.querySelector('.cp-alpha-thumb'),
    fill:pop.querySelector('.cp-fill'),hex:pop.querySelector('.cp-hex'),anum:pop.querySelector('.cp-anum'),apct:pop.querySelector('.cp-apct'),
    h:0,s:1,v:1,a:1,alphaEnabled:true,anchor:null,onInput:null};
  var presets=['#DE2F2A','#F2862E','#F2C53D','#9DC64C','#4fc3f7','#0288d1','#ff9800','#ab47bc','#ffffff','#9e9e9e','#455a64','#111318'];
  var pc=pop.querySelector('.cp-presets');
  presets.forEach(function(col){var b=document.createElement('button');b.type='button';b.className='cp-preset';b.style.backgroundColor=col;b.addEventListener('click',function(){cpSetFromHex(col);});pc.appendChild(b);});
  wireCPDrag();
  CP.hex.addEventListener('input',function(){var v=CP.hex.value.trim().replace('#','');if(/^[0-9a-fA-F]{6}$/.test(v))cpSetFromHex('#'+v);});
  CP.anum.addEventListener('input',function(){var n=Math.max(0,Math.min(100,parseFloat(CP.anum.value)||0));CP.a=n/100;cpRender();cpFire();});
  document.addEventListener('mousedown',function(e){if(CP.el.style.display!=='none'&&!CP.el.contains(e.target)&&!(CP.anchor&&CP.anchor.contains(e.target)))closeColorPopup();});
  document.addEventListener('keydown',function(e){if(e.key==='Escape')closeColorPopup();});
  return CP;
}
function wireCPDrag(){
  function attach(el,onMove){
    var active=false;
    function pt(e){return e.touches&&e.touches[0]?e.touches[0]:e;}
    function move(e){if(!active)return;var r=el.getBoundingClientRect();var p=pt(e);onMove(r,p.clientX,p.clientY);}
    el.addEventListener('mousedown',function(e){active=true;move(e);e.preventDefault();});
    el.addEventListener('touchstart',function(e){active=true;move(e);},{passive:true});
    document.addEventListener('mousemove',move);
    document.addEventListener('touchmove',move,{passive:true});
    document.addEventListener('mouseup',function(){active=false;});
    document.addEventListener('touchend',function(){active=false;});
  }
  attach(CP.sv,function(r,x,y){CP.s=clamp01((x-r.left)/r.width);CP.v=1-clamp01((y-r.top)/r.height);cpRender();cpFire();});
  attach(CP.hue,function(r,x){CP.h=clamp01((x-r.left)/r.width)*360;cpRender();cpFire();});
  attach(CP.alpha,function(r,x){CP.a=clamp01((x-r.left)/r.width);cpRender();cpFire();});
}
function cpRender(){
  CP.sv.style.backgroundColor='hsl('+CP.h+',100%,50%)';
  CP.svThumb.style.left=(CP.s*100)+'%';CP.svThumb.style.top=((1-CP.v)*100)+'%';
  CP.hueThumb.style.left=(CP.h/360*100)+'%';
  var hex=cpHex();var rgb=hexToRgb(hex);
  CP.svThumb.style.backgroundColor=hex;
  CP.fill.style.backgroundColor=hexToRgba(hex,CP.alphaEnabled?CP.a:1);
  CP.alphaGrad.style.background='linear-gradient(to right,rgba('+rgb.r+','+rgb.g+','+rgb.b+',0),rgb('+rgb.r+','+rgb.g+','+rgb.b+'))';
  CP.alphaThumb.style.left=(CP.a*100)+'%';
  if(document.activeElement!==CP.hex)CP.hex.value=hex;
  if(document.activeElement!==CP.anum)CP.anum.value=Math.round(CP.a*100);
}
function cpFire(){if(CP.onInput)CP.onInput(cpHex(),CP.alphaEnabled?CP.a:null);}
function cpSetFromHex(hex){var rgb=hexToRgb(hex);var hsv=rgbToHsv(rgb.r,rgb.g,rgb.b);CP.h=hsv.h;CP.s=hsv.s;CP.v=hsv.v;cpRender();cpFire();}
function openColorPopup(anchor,opts){
  buildColorPopup();
  CP.anchor=anchor;CP.onInput=opts.onInput;CP.alphaEnabled=(opts.alpha!=null);CP.a=CP.alphaEnabled?opts.alpha:1;
  var rgb=hexToRgb(opts.color||'#000000');var hsv=rgbToHsv(rgb.r,rgb.g,rgb.b);CP.h=hsv.h;CP.s=hsv.s;CP.v=hsv.v;
  CP.alpha.style.display=CP.alphaEnabled?'':'none';
  CP.anum.style.display=CP.alphaEnabled?'':'none';
  CP.apct.style.display=CP.alphaEnabled?'':'none';
  CP.el.style.display='';cpRender();positionCP(anchor);
}
function positionCP(anchor){
  var r=anchor.getBoundingClientRect();var pop=CP.el;pop.style.left='0px';pop.style.top='0px';
  var pw=pop.offsetWidth,ph=pop.offsetHeight;var left=r.right-pw,top=r.bottom+6;
  if(left<8)left=8;if(left+pw>window.innerWidth-8)left=window.innerWidth-pw-8;
  if(top+ph>window.innerHeight-8)top=r.top-ph-6;if(top<8)top=8;
  pop.style.left=left+'px';pop.style.top=top+'px';
}
function closeColorPopup(){if(CP&&CP.el)CP.el.style.display='none';}

/* ========== 색상 트리거 컨트롤 ========== */
function makeColorControl(id,obj,colorProp,alphaProp,cb){
  var btn=document.getElementById(id);if(!btn)return;
  var sw=btn.querySelector('.ct-fill');
  function paint(){if(sw)sw.style.backgroundColor=alphaProp?hexToRgba(obj[colorProp],Number(obj[alphaProp])):obj[colorProp];}
  paint();colorControls.push({paint:paint});
  btn.addEventListener('click',function(e){e.stopPropagation();
    openColorPopup(btn,{color:obj[colorProp],alpha:alphaProp?Number(obj[alphaProp]):null,
      onInput:function(hex,a){obj[colorProp]=hex;if(alphaProp&&a!=null)obj[alphaProp]=a;paint();cb();markCloudDirty();}});
  });
}

/* ========== 설정 UI 동기화 (불러오기 후 컨트롤 갱신) ========== */
function formatByStep(el,val){var s=el.getAttribute('step')||'1';var dec=s.indexOf('.')>=0?s.split('.')[1].length:0;return Number(val).toFixed(dec);}
function setRange(id,val,fmt){var el=document.getElementById(id);if(!el)return;el.value=val;var lbl=el.nextElementSibling;if(lbl&&lbl.classList&&lbl.classList.contains('range-val'))lbl.textContent=fmt?fmt(Number(val)):formatByStep(el,val);}
function setCheck(id,val){var el=document.getElementById(id);if(el)el.checked=!!val;}
function syncSettingsUI(){
  colorControls.forEach(function(c){c.paint();});
  setRange('default-stroke-weight',styleConfig.default.strokeWeight);
  setRange('highlight-stroke-weight',styleConfig.highlight.strokeWeight);
  setCheck('smooth-toggle',smoothEnabled);
  setRange('smooth-intensity',smoothIntensity);
  setRange('hex-radius',hexRadiusKm,function(v){return v.toFixed(1)+'km';});
  setCheck('local-label-toggle',localLabelConfig.enabled);
  setRange('local-label-size',localLabelConfig.fontSize);
  setRange('zone-label-size',zoneLabelConfig.fontSize);
  setRange('zone-label-bg-opacity',zoneLabelConfig.bgOpacity);
}

function initSettingsPanel(){
  var toggle=document.getElementById('settings-toggle');
  var section=document.getElementById('settings-section');
  toggle.addEventListener('click',function(){var open=section.style.display!=='none';section.style.display=open?'none':'';toggle.classList.toggle('open',!open);});

  // 색상+투명도 통합 컨트롤 (팝업에서 색상/알파 동시 조절)
  makeColorControl('ct-default-fill',styleConfig.default,'fillColor','fillOpacity',refreshMapStyles);
  makeColorControl('ct-default-stroke',styleConfig.default,'strokeColor','strokeOpacity',refreshMapStyles);
  makeColorControl('ct-highlight-fill',styleConfig.highlight,'fillColor','fillOpacity',refreshMapStyles);
  makeColorControl('ct-highlight-stroke',styleConfig.highlight,'strokeColor','strokeOpacity',refreshMapStyles);
  makeColorControl('ct-hex-fill',hexStyleConfig.default,'fillColor','fillOpacity',refreshHexStyles);
  makeColorControl('ct-hex-stroke',hexStyleConfig.default,'strokeColor','strokeOpacity',refreshHexStyles);
  makeColorControl('ct-hex-sel-fill',hexStyleConfig.selected,'fillColor','fillOpacity',refreshHexStyles);
  makeColorControl('ct-local-label-text',localLabelConfig,'textColor',null,updateLocalLabelStyle);
  makeColorControl('ct-local-label-bg',localLabelConfig,'bgColor','bgOpacity',updateLocalLabelStyle);
  makeColorControl('ct-zone-label-text',zoneLabelConfig,'textColor',null,refreshZoneLabels);

  // 선 굵기 (투명도가 아니므로 슬라이더 유지)
  bindInput('default-stroke-weight','range',styleConfig.default,'strokeWeight',refreshMapStyles);
  bindInput('highlight-stroke-weight','range',styleConfig.highlight,'strokeWeight',refreshMapStyles);

  document.getElementById('smooth-toggle').addEventListener('change',function(){smoothEnabled=this.checked;applyGeoJsonToMap();markCloudDirty();});
  document.getElementById('smooth-intensity').addEventListener('input',function(){
    smoothIntensity=parseFloat(this.value);this.nextElementSibling.textContent=smoothIntensity.toFixed(1);
    if(smoothEnabled) applyGeoJsonToMap();markCloudDirty();
  });

  document.getElementById('hex-radius').addEventListener('input',function(){
    hexRadiusKm=parseFloat(this.value);document.getElementById('hex-radius-label').textContent=hexRadiusKm.toFixed(1)+'km';
    if(currentMode==='trend'){selectedHexes.clear();if(editingZoneId)cancelEditZone();rezoneAllToCurrentRadius();generateHexagons();updateZoneSaveUI();}
    markCloudDirty();
  });

  // 폰 표시영역 오버레이 토글 (관리자)
  var vpToggle=document.getElementById('phone-viewport-toggle');
  if(vpToggle){vpToggle.checked=phoneViewportOn;vpToggle.addEventListener('change',function(){phoneViewportOn=this.checked;updatePhoneViewportOverlay();});}

  // 라벨 옵션
  document.getElementById('local-label-toggle').addEventListener('change',function(){localLabelConfig.enabled=this.checked;if(this.checked)showLocalLabel();else removeLocalLabel();markCloudDirty();});
  bindInput('local-label-size','range',localLabelConfig,'fontSize',updateLocalLabelStyle);
  bindInput('zone-label-size','range',zoneLabelConfig,'fontSize',refreshZoneLabels);
  bindInput('zone-label-bg-opacity','range',zoneLabelConfig,'bgOpacity',refreshZoneLabels);
}

function bindInput(id,type,obj,prop,cb){
  var el=document.getElementById(id);if(!el)return;
  el.addEventListener('input',function(){
    obj[prop]=type==='range'?parseFloat(this.value):this.value;
    if(type==='range'&&this.nextElementSibling) this.nextElementSibling.textContent=parseFloat(this.value).toFixed(this.step&&this.step.indexOf('.')>=0?this.step.split('.')[1].length:0);
    cb(); markCloudDirty();
  });
}

/* ========== 유틸리티 ========== */
function hideMapLoading(){var el=document.getElementById('map-loading');if(el)el.classList.add('hidden');}

function initPanelCollapse(){
  var btn=document.getElementById('panel-collapse');
  var panel=document.getElementById('left-panel');
  if(!btn||!panel) return;
  btn.addEventListener('click',function(){
    var collapsed=panel.classList.toggle('collapsed');
    btn.setAttribute('aria-expanded',collapsed?'false':'true');
    btn.setAttribute('aria-label',collapsed?'패널 펼치기':'패널 접기');
    btn.setAttribute('title',collapsed?'패널 펼치기':'패널 접기');
  });
}

/* ========== 사이드바 폭 조절 (→ 폰 크기, 비율은 cqw로 유지) ========== */
function resizeMaps(){
  if(typeof google==='undefined')return;
  if(map)google.maps.event.trigger(map,'resize');
  if(phoneMap){google.maps.event.trigger(phoneMap,'resize');var c=map&&map.getCenter();if(c){phoneMap.setCenter(c);phoneMap.setZoom(map.getZoom());}}
  updatePhoneViewportOverlay();
}
function initSidebarResize(){
  var sb=document.getElementById('sidebar'),rz=document.getElementById('sidebar-resizer');
  if(!sb||!rz)return;
  function maxW(){return Math.min(720,Math.round(window.innerWidth*0.72));}
  function applyW(w){w=Math.max(300,Math.min(w,maxW()));sb.style.flexBasis=w+'px';sb.style.width=w+'px';try{localStorage.setItem('nowhere_sidebarW',String(w));}catch(e){}return w;}
  var saved=NaN;try{saved=parseInt(localStorage.getItem('nowhere_sidebarW'),10);}catch(e){}
  if(!isNaN(saved))applyW(saved);
  var dragging=false;
  function pt(e){return e.touches&&e.touches[0]?e.touches[0]:e;}
  function move(e){if(!dragging)return;var p=pt(e);applyW(window.innerWidth-p.clientX);if(e.cancelable)e.preventDefault();}
  function up(){if(!dragging)return;dragging=false;document.body.classList.remove('resizing-sb');
    document.removeEventListener('mousemove',move);document.removeEventListener('mouseup',up);
    document.removeEventListener('touchmove',move);document.removeEventListener('touchend',up);resizeMaps();}
  function down(e){dragging=true;document.body.classList.add('resizing-sb');if(e.cancelable)e.preventDefault();
    document.addEventListener('mousemove',move);document.addEventListener('mouseup',up);
    document.addEventListener('touchmove',move,{passive:false});document.addEventListener('touchend',up);}
  rz.addEventListener('mousedown',down);rz.addEventListener('touchstart',down,{passive:false});
  window.addEventListener('resize',function(){if(sb.style.width)applyW(parseInt(sb.style.width,10)||380);});
}

function fitBoundsToData(){var b=new google.maps.LatLngBounds();map.data.forEach(function(f){var g=f.getGeometry();if(g)g.forEachLatLng(function(ll){b.extend(ll);});});if(!b.isEmpty())map.fitBounds(b,60);}

function updateInfoPanel(content){
  var el=document.getElementById('info-text');
  if(!content){el.innerHTML=currentMode==='local'?'폴리곤을 클릭하면 해당 동이 하이라이트됩니다.':'헥사곤을 클릭하여 영역을 선택하세요.<br/><span class="hex-info">복수 선택 가능</span>';el.classList.remove('highlighted');}
  else{el.innerHTML='선택된 구역:<br/><span class="dong-name">'+content+'</span>';el.classList.add('highlighted');}
}

function mapStyles(){return [{elementType:'geometry',stylers:[{color:'#1d2c4d'}]},{elementType:'labels.text.fill',stylers:[{color:'#8ec3b9'}]},{elementType:'labels.text.stroke',stylers:[{color:'#1a3646'}]},{featureType:'administrative',elementType:'geometry',stylers:[{visibility:'off'}]},{featureType:'landscape',elementType:'geometry',stylers:[{color:'#1d3044'}]},{featureType:'poi',elementType:'geometry',stylers:[{color:'#263c3f'}]},{featureType:'road',elementType:'geometry',stylers:[{color:'#304a7d'}]},{featureType:'road.highway',elementType:'geometry',stylers:[{color:'#2c6675'}]},{featureType:'water',elementType:'geometry',stylers:[{color:'#0e1626'}]}];}

/* ========== 인증 · 계정 (Firebase) ========== */
var fbAuth=null, fbDb=null, currentUser=null, currentRole=null;
var cloudData=null, mapReady=false, cloudSaveTimer=null, mapBootStarted=false;

function bootMap(){
  if(mapBootStarted)return; mapBootStarted=true;
  var s=document.createElement('script');
  s.src='https://maps.googleapis.com/maps/api/js?key='+CONFIG.GOOGLE_MAPS_API_KEY+'&callback=initMap';
  s.async=true;s.defer=true;document.head.appendChild(s);
}
function adminEmail(){return (CONFIG.ADMIN_EMAIL||'gihoon.mx@gmail.com').toLowerCase();}

function showAuthOverlay(state,user,msg){
  var ov=document.getElementById('auth-overlay');if(!ov)return;
  ov.classList.remove('hidden');
  var sub=document.getElementById('auth-sub'),login=document.getElementById('google-login-btn'),
      status=document.getElementById('auth-status'),logout=document.getElementById('auth-logout');
  status.classList.remove('deny');
  var email=(user&&user.email)?user.email:'';
  if(state==='signedout'){sub.textContent='위치 기반 하이퍼로컬 · 접근 권한이 필요합니다';login.style.display='';status.innerHTML='';logout.style.display='none';}
  else if(state==='checking'){login.style.display='none';status.innerHTML='<span class="auth-spinner"></span>확인 중…';logout.style.display='none';}
  else if(state==='denied'){login.style.display='none';status.classList.add('deny');status.innerHTML='⛔ 접근 권한이 없는 계정입니다.<br><span class="em">'+escHtml(email)+'</span>'+(msg?'<br>'+escHtml(msg):'');logout.style.display='';logout.textContent='다른 계정으로 로그인';}
  else if(state==='demo'){login.style.display='none';status.innerHTML='🚧 데모 모드는 준비 중입니다.<br><span class="em">'+escHtml(email)+'</span>';logout.style.display='';logout.textContent='로그아웃';}
}
function hideAuthOverlay(){var ov=document.getElementById('auth-overlay');if(ov)ov.classList.add('hidden');}
function showUserChip(user,role){
  var row=document.getElementById('account-row');if(!row)return;
  row.style.display='';
  document.getElementById('account-email').textContent=(user.email||'')+(role==='admin'?' · 관리자':' · 뷰어');
  document.getElementById('allowlist-btn').style.display=(role==='admin')?'':'none';
}

function initAuth(){
  if(typeof firebase==='undefined'||!CONFIG.FIREBASE){hideAuthOverlay();bootMap();return;} // Firebase 미설정 폴백
  firebase.initializeApp(CONFIG.FIREBASE);
  fbAuth=firebase.auth();fbDb=firebase.firestore();
  try{fbAuth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);}catch(e){}
  showAuthOverlay('checking');
  document.getElementById('google-login-btn').addEventListener('click',function(){
    showAuthOverlay('checking');
    fbAuth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(function(err){showAuthOverlay('signedout');console.warn('login fail',err);});
  });
  document.getElementById('auth-logout').addEventListener('click',function(){fbAuth.signOut();});
  var lo=document.getElementById('logout-btn');if(lo)lo.addEventListener('click',function(){fbAuth.signOut();});
  var alBtn=document.getElementById('allowlist-btn');if(alBtn)alBtn.addEventListener('click',openAllowlistManager);
  initAllowlistModal();
  fbAuth.onAuthStateChanged(handleAuth);
}
function handleAuth(user){
  currentUser=user;
  if(!user){currentRole=null;document.body.classList.remove('role-admin','role-user');var row=document.getElementById('account-row');if(row)row.style.display='none';showAuthOverlay('signedout');return;}
  showAuthOverlay('checking');
  var email=(user.email||'').toLowerCase();
  if(email===adminEmail()){grantAccess(user,'admin');return;}
  fbDb.collection('allowlist').doc(email).get().then(function(doc){
    if(doc.exists){grantAccess(user,doc.data().role==='admin'?'admin':'user');}
    else{showAuthOverlay('denied',user);}
  }).catch(function(err){showAuthOverlay('denied',user,'권한 확인 실패: '+err.message);});
}
function grantAccess(user,role){
  currentRole=role;
  document.body.classList.remove('role-admin','role-user');
  document.body.classList.add(role==='admin'?'role-admin':'role-user');
  hideAuthOverlay();showUserChip(user,role);bootMap();
  if(role==='admin')loadCloudData(user.uid); // 데모유저는 뷰잉 전용 (클라우드 로드/저장 없음)
}

function loadCloudData(uid){
  if(!fbDb)return;
  fbDb.collection('users').doc(uid).get().then(function(doc){
    if(doc.exists){cloudData=doc.data();if(mapReady)applyCloudData(cloudData);}
  }).catch(function(e){console.warn('cloud load fail',e);});
}
function applyCloudData(d){
  if(!d)return;
  if(d.settings){var s=d.settings;
    if(s.styleConfig){mergeInto(styleConfig.default,s.styleConfig.default);mergeInto(styleConfig.highlight,s.styleConfig.highlight);}
    if(s.hexStyleConfig){mergeInto(hexStyleConfig.default,s.hexStyleConfig.default);mergeInto(hexStyleConfig.selected,s.hexStyleConfig.selected);}
    if(s.localLabelConfig)mergeInto(localLabelConfig,s.localLabelConfig);
    if(s.zoneLabelConfig)mergeInto(zoneLabelConfig,s.zoneLabelConfig);
    if(s.smoothEnabled!==undefined)smoothEnabled=s.smoothEnabled;
    if(s.smoothIntensity!==undefined)smoothIntensity=s.smoothIntensity;
    if(s.hexRadiusKm!==undefined)hexRadiusKm=s.hexRadiusKm;
  }
  if(Array.isArray(d.zones)){
    trendZones.slice().forEach(function(z){removeZoneFromMap(z);});
    trendZones=[];
    d.zones.forEach(function(z){trendZones.push({id:z.id||('tz_'+Date.now()+'_'+Math.random().toString(36).slice(2,6)),name:z.name,color:z.color,radiusKm:z.radiusKm||hexRadiusKm,hexCenters:z.hexCenters,originalCenters:z.originalCenters||JSON.parse(JSON.stringify(z.hexCenters)),originalRadiusKm:z.originalRadiusKm||z.radiusKm||hexRadiusKm,polygons:[],label:null});});
  }
  syncSettingsUI();refreshMapStyles();refreshHexStyles();applyGeoJsonToMap();
  if(currentMode==='trend'){showAllZonesOnMap();generateHexagons();}
  renderZoneList();refreshZoneLabels();updateLocalLabelStyle();
}
function markCloudDirty(){
  if(!fbDb||!currentUser||currentRole!=='admin')return;
  clearTimeout(cloudSaveTimer);cloudSaveTimer=setTimeout(cloudSave,1500);
}
function cloudSave(){
  if(!fbDb||!currentUser)return;
  var payload={updatedAt:firebase.firestore.FieldValue.serverTimestamp(),email:currentUser.email||'',
    settings:{styleConfig:styleConfig,hexStyleConfig:hexStyleConfig,localLabelConfig:localLabelConfig,zoneLabelConfig:zoneLabelConfig,smoothEnabled:smoothEnabled,smoothIntensity:smoothIntensity,hexRadiusKm:hexRadiusKm},
    zones:trendZones.map(function(z){return {id:z.id,name:z.name,color:z.color,radiusKm:z.radiusKm,hexCenters:z.hexCenters,originalCenters:z.originalCenters,originalRadiusKm:z.originalRadiusKm};})};
  fbDb.collection('users').doc(currentUser.uid).set(payload,{merge:true}).catch(function(e){console.warn('cloud save fail',e);});
}

/* ========== 접근권한(allowlist) 관리 ========== */
function initAllowlistModal(){
  var modal=document.getElementById('allowlist-modal');if(!modal)return;
  document.getElementById('allowlist-close').addEventListener('click',function(){modal.style.display='none';});
  modal.addEventListener('click',function(e){if(e.target===modal)modal.style.display='none';});
  document.getElementById('al-add-btn').addEventListener('click',addAllowlistEntry);
  document.getElementById('al-email').addEventListener('keydown',function(e){if(e.key==='Enter')addAllowlistEntry();});
}
function openAllowlistManager(){var modal=document.getElementById('allowlist-modal');if(!modal)return;modal.style.display='flex';renderAllowlist();}
function renderAllowlist(){
  var list=document.getElementById('al-list');if(!list||!fbDb)return;
  list.innerHTML='<div class="al-empty">불러오는 중…</div>';
  fbDb.collection('allowlist').get().then(function(snap){
    list.innerHTML='';
    if(snap.empty){list.innerHTML='<div class="al-empty">등록된 유저가 없습니다.</div>';return;}
    snap.forEach(function(doc){
      var role=doc.data().role==='admin'?'admin':'user';
      var item=document.createElement('div');item.className='al-item';
      item.innerHTML='<span class="al-mail">'+escHtml(doc.id)+'</span><span class="al-tag '+role+'">'+(role==='admin'?'관리자':'데모유저')+'</span><button class="al-del" title="삭제">🗑️</button>';
      item.querySelector('.al-del').addEventListener('click',function(){fbDb.collection('allowlist').doc(doc.id).delete().then(renderAllowlist);});
      list.appendChild(item);
    });
  }).catch(function(e){list.innerHTML='<div class="al-empty">불러오기 실패: '+escHtml(e.message)+'</div>';});
}
function addAllowlistEntry(){
  var emailEl=document.getElementById('al-email'),roleEl=document.getElementById('al-role');
  var email=(emailEl.value||'').trim().toLowerCase();
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){emailEl.focus();return;}
  fbDb.collection('allowlist').doc(email).set({role:roleEl.value,addedBy:currentUser?currentUser.email:'',addedAt:firebase.firestore.FieldValue.serverTimestamp()}).then(function(){emailEl.value='';renderAllowlist();}).catch(function(e){alert('추가 실패: '+e.message);});
}

(function(){
  initPanelCollapse();
  initPhoneControls();
  initSidebarResize();
  if(typeof CONFIG==='undefined'||!CONFIG.GOOGLE_MAPS_API_KEY){var it=document.getElementById('info-text');if(it)it.textContent='⚠️ config.js에 API 키를 설정해 주세요.';hideMapLoading();hideAuthOverlay();return;}
  initAuth();
})();
