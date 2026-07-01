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
  map.data.setStyle(function(f) { return f === selectedFeature ? getHighlightStyle() : getDefaultStyle(); });
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
  selectedFeature = null; updateInfoPanel(null);
  map.data.forEach(function(f){map.data.remove(f);});
  map.data.addGeoJson(smoothEnabled ? smoothGeoJson(originalGeoJson,smoothIntensity) : originalGeoJson);
  refreshMapStyles();
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

/* ========== 커스텀 라벨 오버레이 ========== */
function ZoneLabel(pos,text,color,m){this.position=pos;this.text=text;this.color=color;this.div=null;this.setMap(m);}
function initZoneLabelClass(){
  ZoneLabel.prototype=new google.maps.OverlayView();
  ZoneLabel.prototype.onAdd=function(){var d=document.createElement('div');d.className='zone-label-tag';d.style.backgroundColor=this.color;d.textContent=this.text;this.div=d;this.getPanes().overlayMouseTarget.appendChild(d);};
  ZoneLabel.prototype.draw=function(){var p=this.getProjection();if(!p)return;var pos=p.fromLatLngToDivPixel(this.position);if(this.div&&pos){this.div.style.left=pos.x+'px';this.div.style.top=pos.y+'px';}};
  ZoneLabel.prototype.onRemove=function(){if(this.div&&this.div.parentNode){this.div.parentNode.removeChild(this.div);this.div=null;}};
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
    zone.label=new ZoneLabel(new google.maps.LatLng(sumLat/zone.hexCenters.length,sumLng/zone.hexCenters.length),zone.name,zone.color,map);
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
      hexRadiusKm: hexRadiusKm
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
        if(s.styleConfig) styleConfig = JSON.parse(JSON.stringify(s.styleConfig));
        if(s.hexStyleConfig) hexStyleConfig = JSON.parse(JSON.stringify(s.hexStyleConfig));
        if(s.smoothEnabled !== undefined) smoothEnabled = s.smoothEnabled;
        if(s.smoothIntensity !== undefined) smoothIntensity = s.smoothIntensity;
        if(s.hexRadiusKm !== undefined) hexRadiusKm = s.hexRadiusKm;
        
        document.getElementById('default-fill').value = styleConfig.default.fillColor;
        document.getElementById('default-stroke').value = styleConfig.default.strokeColor;
        document.getElementById('default-fill-opacity').value = styleConfig.default.fillOpacity;
        if(document.getElementById('default-fill-opacity').nextElementSibling) document.getElementById('default-fill-opacity').nextElementSibling.textContent = Number(styleConfig.default.fillOpacity).toFixed(2);
        document.getElementById('default-stroke-opacity').value = styleConfig.default.strokeOpacity;
        if(document.getElementById('default-stroke-opacity').nextElementSibling) document.getElementById('default-stroke-opacity').nextElementSibling.textContent = Number(styleConfig.default.strokeOpacity).toFixed(2);
        document.getElementById('default-stroke-weight').value = styleConfig.default.strokeWeight;
        if(document.getElementById('default-stroke-weight').nextElementSibling) document.getElementById('default-stroke-weight').nextElementSibling.textContent = Number(styleConfig.default.strokeWeight).toFixed(1);

        document.getElementById('highlight-fill').value = styleConfig.highlight.fillColor;
        document.getElementById('highlight-stroke').value = styleConfig.highlight.strokeColor;
        document.getElementById('highlight-fill-opacity').value = styleConfig.highlight.fillOpacity;
        if(document.getElementById('highlight-fill-opacity').nextElementSibling) document.getElementById('highlight-fill-opacity').nextElementSibling.textContent = Number(styleConfig.highlight.fillOpacity).toFixed(2);
        document.getElementById('highlight-stroke-opacity').value = styleConfig.highlight.strokeOpacity;
        if(document.getElementById('highlight-stroke-opacity').nextElementSibling) document.getElementById('highlight-stroke-opacity').nextElementSibling.textContent = Number(styleConfig.highlight.strokeOpacity).toFixed(2);
        document.getElementById('highlight-stroke-weight').value = styleConfig.highlight.strokeWeight;
        if(document.getElementById('highlight-stroke-weight').nextElementSibling) document.getElementById('highlight-stroke-weight').nextElementSibling.textContent = Number(styleConfig.highlight.strokeWeight).toFixed(1);

        document.getElementById('smooth-toggle').checked = smoothEnabled;
        document.getElementById('smooth-intensity').value = smoothIntensity;
        if(document.getElementById('smooth-intensity').nextElementSibling) document.getElementById('smooth-intensity').nextElementSibling.textContent = Number(smoothIntensity).toFixed(1);

        document.getElementById('hex-radius').value = hexRadiusKm;
        document.getElementById('hex-radius-label').textContent = Number(hexRadiusKm).toFixed(1)+'km';

        document.getElementById('hex-fill').value = hexStyleConfig.default.fillColor;
        document.getElementById('hex-stroke').value = hexStyleConfig.default.strokeColor;
        document.getElementById('hex-fill-opacity').value = hexStyleConfig.default.fillOpacity;
        if(document.getElementById('hex-fill-opacity').nextElementSibling) document.getElementById('hex-fill-opacity').nextElementSibling.textContent = Number(hexStyleConfig.default.fillOpacity).toFixed(2);
        
        document.getElementById('hex-sel-fill').value = hexStyleConfig.selected.fillColor;
        document.getElementById('hex-sel-opacity').value = hexStyleConfig.selected.fillOpacity;
        if(document.getElementById('hex-sel-opacity').nextElementSibling) document.getElementById('hex-sel-opacity').nextElementSibling.textContent = Number(hexStyleConfig.selected.fillOpacity).toFixed(2);

        refreshMapStyles();
        refreshHexStyles();
        applyGeoJsonToMap();
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
}

/* ========== 초기화 ========== */
function initMap(){
  initZoneLabelClass();
  var opts={center:{lat:CONFIG.MAP_CENTER_LAT,lng:CONFIG.MAP_CENTER_LNG},zoom:CONFIG.MAP_ZOOM,disableDefaultUI:false,zoomControl:true,mapTypeControl:false,streetViewControl:false,fullscreenControl:true};
  if(CONFIG.MAP_ID&&CONFIG.MAP_ID.length>0) opts.mapId=CONFIG.MAP_ID; else opts.styles=mapStyles();
  map=new google.maps.Map(document.getElementById('map'),opts);
  fetch(CONFIG.GEOJSON_PATH).then(function(r){return r.json();}).then(function(geo){originalGeoJson=geo;applyGeoJsonToMap();fitBoundsToData();loadZonesFromStorage();});
  refreshMapStyles();
  map.data.addListener('click',function(e){if(currentMode!=='local')return;var f=e.feature;if(selectedFeature===f){selectedFeature=null;refreshMapStyles();updateInfoPanel(null);return;}selectedFeature=f;refreshMapStyles();var raw=f.getProperty('adm_nm')||f.getProperty('name')||'(이름 없음)';var p=raw.split(' ');updateInfoPanel(p.length>2?p.slice(2).join(' '):raw);});
  map.addListener('click',function(){if(currentMode==='local'&&selectedFeature){selectedFeature=null;refreshMapStyles();updateInfoPanel(null);}});
  map.data.addListener('mouseover',function(e){if(currentMode!=='local'||e.feature===selectedFeature)return;map.data.overrideStyle(e.feature,{strokeWeight:Number(styleConfig.default.strokeWeight)+2,fillOpacity:Number(styleConfig.default.fillOpacity)+0.08});});
  map.data.addListener('mouseout',function(e){if(currentMode!=='local'||e.feature===selectedFeature)return;map.data.revertStyle(e.feature);});
  initSettingsPanel();initModeToggle();initZoneForm();initZoneEditBar();initZoneIO();
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

function initSettingsPanel(){
  var toggle=document.getElementById('settings-toggle');
  var section=document.getElementById('settings-section');
  toggle.addEventListener('click',function(){var open=section.style.display!=='none';section.style.display=open?'none':'';toggle.classList.toggle('open',!open);});

  bindInput('default-fill','color',styleConfig.default,'fillColor',refreshMapStyles);
  bindInput('default-stroke','color',styleConfig.default,'strokeColor',refreshMapStyles);
  bindInput('default-fill-opacity','range',styleConfig.default,'fillOpacity',refreshMapStyles);
  bindInput('default-stroke-opacity','range',styleConfig.default,'strokeOpacity',refreshMapStyles);
  bindInput('default-stroke-weight','range',styleConfig.default,'strokeWeight',refreshMapStyles);
  bindInput('highlight-fill','color',styleConfig.highlight,'fillColor',refreshMapStyles);
  bindInput('highlight-stroke','color',styleConfig.highlight,'strokeColor',refreshMapStyles);
  bindInput('highlight-fill-opacity','range',styleConfig.highlight,'fillOpacity',refreshMapStyles);
  bindInput('highlight-stroke-opacity','range',styleConfig.highlight,'strokeOpacity',refreshMapStyles);
  bindInput('highlight-stroke-weight','range',styleConfig.highlight,'strokeWeight',refreshMapStyles);

  document.getElementById('smooth-toggle').addEventListener('change',function(){smoothEnabled=this.checked;applyGeoJsonToMap();});
  document.getElementById('smooth-intensity').addEventListener('input',function(){
    smoothIntensity=parseFloat(this.value);this.nextElementSibling.textContent=smoothIntensity.toFixed(1);
    if(smoothEnabled) applyGeoJsonToMap();
  });

  document.getElementById('hex-radius').addEventListener('input',function(){
    hexRadiusKm=parseFloat(this.value);document.getElementById('hex-radius-label').textContent=hexRadiusKm.toFixed(1)+'km';
    if(currentMode==='trend'){selectedHexes.clear();if(editingZoneId)cancelEditZone();rezoneAllToCurrentRadius();generateHexagons();updateZoneSaveUI();}
  });

  bindInput('hex-fill','color',hexStyleConfig.default,'fillColor',refreshHexStyles);
  bindInput('hex-stroke','color',hexStyleConfig.default,'strokeColor',refreshHexStyles);
  bindInput('hex-fill-opacity','range',hexStyleConfig.default,'fillOpacity',refreshHexStyles);
  bindInput('hex-sel-fill','color',hexStyleConfig.selected,'fillColor',refreshHexStyles);
  bindInput('hex-sel-opacity','range',hexStyleConfig.selected,'fillOpacity',refreshHexStyles);
}

function bindInput(id,type,obj,prop,cb){
  var el=document.getElementById(id);if(!el)return;
  el.addEventListener('input',function(){
    obj[prop]=type==='range'?parseFloat(this.value):this.value;
    if(type==='range'&&this.nextElementSibling) this.nextElementSibling.textContent=parseFloat(this.value).toFixed(this.step&&this.step.indexOf('.')>=0?this.step.split('.')[1].length:0);
    cb();
  });
}

/* ========== 유틸리티 ========== */
function fitBoundsToData(){var b=new google.maps.LatLngBounds();map.data.forEach(function(f){var g=f.getGeometry();if(g)g.forEachLatLng(function(ll){b.extend(ll);});});if(!b.isEmpty())map.fitBounds(b,60);}

function updateInfoPanel(content){
  var el=document.getElementById('info-text');
  if(!content){el.innerHTML=currentMode==='local'?'폴리곤을 클릭하면 해당 동이 하이라이트됩니다.':'헥사곤을 클릭하여 영역을 선택하세요.<br/><span class="hex-info">복수 선택 가능</span>';el.classList.remove('highlighted');}
  else{el.innerHTML='선택된 구역:<br/><span class="dong-name">'+content+'</span>';el.classList.add('highlighted');}
}

function mapStyles(){return [{elementType:'geometry',stylers:[{color:'#1d2c4d'}]},{elementType:'labels.text.fill',stylers:[{color:'#8ec3b9'}]},{elementType:'labels.text.stroke',stylers:[{color:'#1a3646'}]},{featureType:'administrative',elementType:'geometry',stylers:[{visibility:'off'}]},{featureType:'landscape',elementType:'geometry',stylers:[{color:'#1d3044'}]},{featureType:'poi',elementType:'geometry',stylers:[{color:'#263c3f'}]},{featureType:'road',elementType:'geometry',stylers:[{color:'#304a7d'}]},{featureType:'road.highway',elementType:'geometry',stylers:[{color:'#2c6675'}]},{featureType:'water',elementType:'geometry',stylers:[{color:'#0e1626'}]}];}

(function(){
  if(typeof CONFIG==='undefined'||!CONFIG.GOOGLE_MAPS_API_KEY){document.getElementById('info-text').textContent='⚠️ config.js에 API 키를 설정해 주세요.';return;}
  if(CONFIG.GOOGLE_MAPS_API_KEY==='YOUR_API_KEY'){document.getElementById('info-text').textContent='⚠️ config.js에 실제 API 키를 입력해 주세요.';return;}
  var s=document.createElement('script');s.src='https://maps.googleapis.com/maps/api/js?key='+CONFIG.GOOGLE_MAPS_API_KEY+'&callback=initMap';s.async=true;s.defer=true;document.head.appendChild(s);
})();
