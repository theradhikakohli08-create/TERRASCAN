// ============================================================================
// TERRASCAN: NET ZERO AI DASHBOARD
// (Sentinel-2 + Landsat 8 + Sentinel-1 waterlogging)
// ============================================================================

var GEMINI_BRIDGE_URL='https://script.google.com/macros/s/AKfycbxAaFCwSueP2X8gW_tFqR3mRFoJ_VzxFQehXKqCta0Jvsi1KgiUoGtfedQQMoIL9E8u1A/exec';

// ---------------------------------------------------------------------------
// GLOBAL SETTINGS (change values here only)
// ---------------------------------------------------------------------------
var CLOUD_MAX = 20;          // max cloud % for Sentinel-2 AND Landsat 8, used everywhere
var FLOOD_VV_DB = -16;       // Sentinel-1 VV backscatter below this = open water (dB)
var FLOOD_DIFF_DB = -3;      // drop vs dry season must be at least this much (dB)
var PERM_WATER_OCC = 25;     // JRC occurrence % above this = permanent water (excluded)
var MAX_SLOPE_DEG = 5;       // flooding ignored on slopes steeper than this

// --- Planting / carbon estimate (area-based, uses ESA WorldCover land cover) ---
var GREEN_TARGET_NDVI = 0.30;   // below this = low green cover
var TREES_PER_HA = 400;         // urban plantation density (assumption)
var SURVIVAL_RATE = 0.8;        // share of planted saplings that survive (assumption)
var CO2_KG_LOW = 10;            // kg CO2 per tree per year, low estimate (assumption)
var CO2_KG_HIGH = 25;           // kg CO2 per tree per year, high estimate (assumption)

var defaultGeometry = ee.Geometry.Polygon(
  [[[76.84, 28.40], [77.35, 28.40], [77.35, 28.88], [76.84, 28.88]]]
);

var locations = {
  'Delhi (National Capital Territory)': defaultGeometry,
  
  'United Kingdom (UK - London Region)': ee.Geometry.Polygon([[[0.1, 51.5], [-0.2, 51.5], [-0.2, 51.6], [0.1, 51.6]]]),
  'United States (USA - NYC Region)': ee.Geometry.Polygon([[[-74.0, 40.7], [-73.9, 40.7], [-73.9, 40.8], [-74.0, 40.8]]]),
  'China (Beijing Region)': ee.Geometry.Polygon([[[116.3, 39.9], [116.4, 39.9], [116.4, 40.0], [116.3, 40.0]]]),
  'Russia (Moscow Region)': ee.Geometry.Polygon([[[37.5, 55.7], [37.7, 55.7], [37.7, 55.8], [37.5, 55.8]]]),
  'Brazil (Brasília Region)': ee.Geometry.Polygon([[[-48.0, -15.8], [-47.8, -15.8], [-47.8, -15.7], [-48.0, -15.7]]]),
  'Australia (Sydney Region)': ee.Geometry.Polygon([[[151.1, -33.9], [151.3, -33.9], [151.3, -33.7], [151.1, -33.7]]]),
  'Japan (Tokyo Region)': ee.Geometry.Polygon([[[139.6, 35.6], [139.7, 35.6], [139.7, 35.7], [139.6, 35.7]]]),

  'Uttar Pradesh (Western Region)': ee.Geometry.Polygon([[[77.0, 27.0], [80.0, 27.0], [80.0, 29.0], [77.0, 29.0]]]),
  'Maharashtra (Mumbai Region)': ee.Geometry.Polygon([[[72.7, 18.8], [73.0, 18.8], [73.0, 19.3], [72.7, 19.3]]]),
  'Karnataka (Bengaluru Region)': ee.Geometry.Polygon([[[77.4, 12.8], [77.8, 12.8], [77.8, 13.1], [77.4, 13.1]]]),
  'Tamil Nadu (Chennai Region)': ee.Geometry.Polygon([[[80.1, 12.9], [80.3, 12.9], [80.3, 13.2], [80.1, 13.2]]]),
  'West Bengal (Kolkata Region)': ee.Geometry.Polygon([[[88.3, 22.5], [88.5, 22.5], [88.5, 22.7], [88.3, 22.7]]]),
  'Gujarat (Ahmedabad Region)': ee.Geometry.Polygon([[[72.5, 23.0], [72.7, 23.0], [72.7, 23.1], [72.5, 23.1]]]),
  'Rajasthan (Jaipur Region)': ee.Geometry.Polygon([[[75.7, 26.8], [75.9, 26.8], [75.9, 27.0], [75.7, 27.0]]]),
  'Madhya Pradesh (Bhopal Region)': ee.Geometry.Polygon([[[77.3, 23.2], [77.5, 23.2], [77.5, 23.4], [77.3, 23.4]]]),
  'Punjab & Haryana (Chandigarh Region)': ee.Geometry.Polygon([[[76.7, 30.6], [76.9, 30.6], [76.9, 30.8], [76.7, 30.8]]]),
  'Kerala (Kochi Region)': ee.Geometry.Polygon([[[76.2, 9.9], [76.4, 9.9], [76.4, 10.1], [76.2, 10.1]]]),
  'Bihar (Patna Region)': ee.Geometry.Polygon([[[85.0, 25.5], [85.2, 25.5], [85.2, 25.7], [85.0, 25.7]]])
};

var currentKey = 'Delhi (National Capital Territory)';
var currentAoi = locations[currentKey];
var currentYear = '2026-01-01';

var searchHistory = [];

// --- Gemini state: latest computed results + the user's question ---
var lastSummary = null;
var lastFlood = null;
var lastCarbon = null;
var userQuestion = 'Summarize this audit and tell me what to do first.';

// ---------------------------------------------------------------------------
// SHARED HELPER: one Sentinel-2 median composite used by BOTH the scorecard
// and the trend chart, so their NDVI values always match.
// ---------------------------------------------------------------------------
var getS2Median = function(geometry, start, end) {
  return ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(geometry)
    .filterDate(start, end)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', CLOUD_MAX))
    .median()
    .clip(geometry);
};

var map = ui.Map();
map.centerObject(currentAoi, 11);

var controlPanel = ui.Panel({
  style: {
    width: '440px',
    padding: '14px',
    stretch: 'vertical',
    backgroundColor: '#fafafa'
  }
});

var headerCard = ui.Panel({
  style: {
    backgroundColor: '#e8f5e9',
    padding: '12px',
    margin: '0 0 12px 0',
    border: '1px solid #81c784',
    borderRadius: '6px'
  }
});
headerCard.add(ui.Label({
  value: 'TerraScan: Net Zero AI Dashboard',
  style: {fontSize: '16px', fontWeight: 'bold', color: '#1b5e20', margin: '0 0 4px 0'}
}));
headerCard.add(ui.Label({
  value: 'Advanced Environmental Audit & Climate Mitigation',
  style: {fontSize: '11px', color: '#37474f', margin: '0'}
}));
controlPanel.add(headerCard);

controlPanel.add(ui.Label('1. Select Region of Interest:', {fontWeight: 'bold', color: '#2c3e50'}));
var selectAoi = ui.Select({
  items: Object.keys(locations),
  placeholder: 'Select Region...',
  value: currentKey,
  onChange: function(key) {
    currentKey = key;
    currentAoi = locations[key];
    map.centerObject(currentAoi, 11);
    updateDashboard(currentAoi, currentYear, currentKey);
  }
});
controlPanel.add(selectAoi);

controlPanel.add(ui.Label('2. Select Analysis Year:', {fontWeight: 'bold', color: '#2c3e50'}));
var selectYear = ui.Select({
  items: ['2026 (Current)', '2025', '2024', '2023', '2022', '2021', '2020 (Baseline)'],
  placeholder: 'Select Year...',
  value: '2026 (Current)',
  onChange: function(yKey) {
    var parsedYear = yKey.substring(0, 4);
    currentYear = parsedYear + '-01-01';
    updateDashboard(currentAoi, currentYear, currentKey);
  }
});
controlPanel.add(selectYear);

controlPanel.add(ui.Label('3. Audit Scorecard:', {fontWeight: 'bold', color: '#2c3e50'}));
var statsPanel = ui.Panel({
  style: {
    backgroundColor: '#e8f5e9',
    padding: '10px',
    margin: '6px 0 12px 0',
    border: '1px solid #81c784',
    borderRadius: '6px'
  }
});
controlPanel.add(statsPanel);

controlPanel.add(ui.Label('4. AI Eco-Health & Adaptive Policy Insights:', {fontWeight: 'bold', color: '#2c3e50'}));
var aiInsightsPanel = ui.Panel({
  style: {
    backgroundColor: '#fff8e1',
    padding: '10px',
    margin: '6px 0 12px 0',
    border: '1px solid #ffb74d',
    borderRadius: '6px'
  }
});
controlPanel.add(aiInsightsPanel);

controlPanel.add(ui.Label('5. Carbon Offset & Mitigation Calculator:', {fontWeight: 'bold', color: '#2c3e50'}));
var carbonPanel = ui.Panel({
  style: {
    backgroundColor: '#e3f2fd',
    padding: '10px',
    margin: '6px 0 12px 0',
    border: '1px solid #64b5f6',
    borderRadius: '6px'
  }
});
controlPanel.add(carbonPanel);

// 6. NEW: Sentinel-1 waterlogging panel
controlPanel.add(ui.Label('6. Waterlogging / Flood Risk (Sentinel-1 Radar):', {fontWeight: 'bold', color: '#2c3e50'}));
var floodPanel = ui.Panel({
  style: {
    backgroundColor: '#e0f7fa',
    padding: '10px',
    margin: '6px 0 12px 0',
    border: '1px solid #4dd0e1',
    borderRadius: '6px'
  }
});
controlPanel.add(floodPanel);

controlPanel.add(ui.Label('7. Toggle Map Layers:', {fontWeight: 'bold', color: '#2c3e50'}));
var layerCheckboxes = [];
var createCheckbox = function(labelName, layerIndex) {
  var cb = ui.Checkbox({
    label: labelName,
    value: (layerIndex === 3),
    onChange: function(checked) {
      var targetLayer = map.layers().get(layerIndex + 1);
      if (targetLayer) { targetLayer.setShown(checked); }
    }
  });
  layerCheckboxes.push(cb);
  return cb;
};

controlPanel.add(createCheckbox('Green Cover (NDVI)', 0));
controlPanel.add(createCheckbox('Water Bodies (NDWI)', 1));
controlPanel.add(createCheckbox('Concrete Density (NDBI)', 2));
controlPanel.add(createCheckbox('Urban Heat Island (LST)', 3));
controlPanel.add(createCheckbox('Waterlogging (Sentinel-1)', 4));

controlPanel.add(ui.Label('8. Session History & Comparison Log:', {fontWeight: 'bold', color: '#2c3e50'}));
var historyPanel = ui.Panel({
  style: {
    backgroundColor: '#eceff1',
    padding: '8px',
    margin: '6px 0 12px 0',
    border: '1px solid #b0bec5',
    borderRadius: '6px',
    maxHeight: '130px'
  }
});
controlPanel.add(historyPanel);

controlPanel.add(ui.Label('9. Longitudinal Trend (2020 - 2026):', {fontWeight: 'bold', color: '#2c3e50'}));
var chartPanel = ui.Panel();
controlPanel.add(chartPanel);

// 10. GEMINI AI ASSISTANT (Direct UI Response Box)
controlPanel.add(ui.Label('10. Ask TerraScan AI (Gemini):', {fontWeight: 'bold', color: '#2c3e50'}));
var geminiPanel = ui.Panel({
  style: {
    backgroundColor: '#f3e8fd',
    padding: '10px',
    margin: '6px 0 12px 0',
    border: '1px solid #b388eb',
    borderRadius: '6px'
  }
});
geminiPanel.add(ui.Label(
  'Type a question about the current region/year and click the button. A quick rule-based summary appears here, and a link opens the full Gemini answer in a new tab.',
  {fontSize: '11px', color: '#455a64'}
));
var questionBox = ui.Textbox({
  placeholder: 'e.g. Where should we plant trees first?',
  value: userQuestion,
  onChange: function(v) {
    userQuestion = v;
  },
  style: {stretch: 'horizontal'}
});
geminiPanel.add(questionBox);

var geminiAnswerBox = ui.Label({
  value: 'Click button below to generate AI analysis.',
  style: {fontSize: '11px', color: '#4a148c', margin: '8px 0 4px 0', whiteSpace: 'pre-wrap'}
});

// Link that opens the real Gemini answer (served by the Apps Script bridge)
var geminiLink = ui.Label('', {fontSize: '12px', fontWeight: 'bold', color: '#6a1b9a', margin: '4px 0 4px 0', shown: false});

// Builds the text that is sent to Gemini: real computed numbers + the user's question
var buildGeminiPrompt = function() {
  var f = lastFlood
    ? 'Waterlogged area (Sentinel-1): ' + lastFlood.km2 + ' km2 (' + lastFlood.pct + '% of region). '
    : 'Waterlogging data unavailable. ';
  return 'Region: ' + lastSummary.r + '. Year: ' + lastSummary.y + '. ' +
    'NDVI: ' + lastSummary.ndvi + '. NDWI: ' + lastSummary.ndwi + '. NDBI: ' + lastSummary.ndbi + '. ' +
    'Land surface temperature: ' + lastSummary.lst + ' C. ' +
    'Eco-health grade: ' + lastSummary.grade + '. ' + f +
    'Question: ' + userQuestion;
};

var askGeminiButton = ui.Button({
  label: 'Ask Gemini AI Now',
  onClick: function() {
    if (!lastSummary) {
      geminiAnswerBox.setValue('Please wait for regional data to finish computing.');
      return;
    }
    var floodLine = lastFlood
      ? ' Sentinel-1 radar shows ~' + lastFlood.km2 + ' km2 (' + lastFlood.pct + '% of the region) waterlogged in the monsoon window.'
      : ' Waterlogging data is still computing or unavailable.';

    // 1) instant rule-based summary (works offline)
    geminiAnswerBox.setValue('Quick summary (rule-based) for ' + lastSummary.r + ' (' + lastSummary.y + '):\n\nQuery: "' + userQuestion + '"\n\nNDVI ' + lastSummary.ndvi + ', LST ' + lastSummary.lst + ' C, grade ' + lastSummary.grade + '. Priority: ' + lastSummary.advice + ' Sapling deficit estimate: ' + lastSummary.trees + '.' + floodLine);

    // 2) link to the real Gemini answer (GEE cannot call web APIs directly)
    var url = GEMINI_BRIDGE_URL + '?q=' + encodeURIComponent(buildGeminiPrompt());
    geminiLink.setValue('Open full Gemini AI answer  \u2197');
    geminiLink.setUrl(url);
    geminiLink.style().set('shown', true);
  },
  style: {backgroundColor: '#b388eb', stretch: 'horizontal'}
});

geminiPanel.add(askGeminiButton);
geminiPanel.add(geminiLink);
geminiPanel.add(geminiAnswerBox);
controlPanel.add(geminiPanel);

var updateDashboard = function(geometry, targetYear, regionName) {
  map.layers().reset();
  map.addLayer(geometry, {color: 'red'}, 'Selected AOI Border', true, 0.5);

  lastSummary = null;
  lastFlood = null;
  lastCarbon = null;
  carbonPanel.clear();
  carbonPanel.add(ui.Label('Computing planting potential...', {color: '#555'}));
  geminiLink.style().set('shown', false);
  geminiAnswerBox.setValue('Computing new region metrics...');
  
  var yearVal = parseInt(targetYear.substring(0,4));
  var startDate = targetYear;
  var endDate = (yearVal + 1).toString() + '-01-01';
  
  // Sentinel-2 (same helper as the chart)
  var s2 = getS2Median(geometry, startDate, endDate);
    
  var ndvi = s2.normalizedDifference(['B8', 'B4']).rename('NDVI');
  var ndwi = s2.normalizedDifference(['B3', 'B8']).rename('NDWI');
  var ndbi = s2.normalizedDifference(['B11', 'B8']).rename('NDBI');
  
  // Landsat 8 (cloud filter now matches CLOUD_MAX)
  var l8 = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
    .filterBounds(geometry)
    .filterDate(startDate, endDate)
    .filter(ee.Filter.lt('CLOUD_COVER', CLOUD_MAX))
    .median()
    .clip(geometry);
    
  var lstRaw = l8.select('ST_B10').multiply(0.00341802).add(149.0).subtract(273.15).rename('LST');
  var lst = lstRaw.resample('bilinear');

  // ---- Sentinel-1 waterlogging (pre-monsoon vs monsoon of the selected year) ----
  var s1 = ee.ImageCollection('COPERNICUS/S1_GRD')
    .filterBounds(geometry)
    .filter(ee.Filter.eq('instrumentMode', 'IW'))
    .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
    .filter(ee.Filter.eq('orbitProperties_pass', 'DESCENDING'))
    .select('VV');

  var s1Before = s1.filterDate(yearVal + '-03-01', yearVal + '-06-01')
    .median().focal_median(30, 'circle', 'meters');
  var s1After = s1.filterDate(yearVal + '-07-01', yearVal + '-10-01')
    .median().focal_median(30, 'circle', 'meters');

  var floodRaw = s1After.subtract(s1Before).lt(FLOOD_DIFF_DB)
    .and(s1After.lt(FLOOD_VV_DB))
    .rename('FLOOD');

  var permWater = ee.Image('JRC/GSW1_4/GlobalSurfaceWater').select('occurrence')
    .gt(PERM_WATER_OCC).unmask(0);
  var flatLand = ee.Algorithms.Terrain(ee.Image('USGS/SRTMGL1_003')).select('slope')
    .lt(MAX_SLOPE_DEG);

  var flooded = floodRaw
    .updateMask(permWater.not())
    .updateMask(flatLand)
    .selfMask()
    .clip(geometry);

  // Layer order matters for the checkboxes: 1 NDVI, 2 NDWI, 3 NDBI, 4 LST, 5 Flood
  map.layers().add(ui.Map.Layer(ndvi, {min: 0, max: 1, palette: ['blue', 'white', 'green']}, 'Green Cover (NDVI)', false));
  map.layers().add(ui.Map.Layer(ndwi, {min: -1, max: 1, palette: ['brown', 'white', 'blue']}, 'Water Bodies (NDWI)', false));
  map.layers().add(ui.Map.Layer(ndbi, {min: -1, max: 1, palette: ['blue', 'yellow', 'red']}, 'Concrete Density (NDBI)', false));
  map.layers().add(ui.Map.Layer(lst, {min: 20, max: 45, palette: ['blue', 'yellow', 'orange', 'red']}, 'Urban Heat Island (LST)', true));
  map.layers().add(ui.Map.Layer(flooded, {palette: ['0000ff']}, 'Waterlogging (Sentinel-1)', false));

  // keep checkboxes in sync with the freshly reset layers
  for (var c = 0; c < layerCheckboxes.length; c++) {
    layerCheckboxes[c].setValue(c === 3);
  }

  statsPanel.clear();
  statsPanel.add(ui.Label('Computing metrics for ' + yearVal + '...', {color: '#555'}));

  floodPanel.clear();
  floodPanel.add(ui.Label('Computing waterlogging for ' + yearVal + ' monsoon...', {color: '#555'}));

  // ---- Flood area statistics ----
  var floodArea = flooded.unmask(0).multiply(ee.Image.pixelArea()).reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: geometry,
    scale: 60,
    maxPixels: 1e9,
    bestEffort: true
  }).get('FLOOD');

  ee.Dictionary({flood: floodArea, aoi: geometry.area(1)}).evaluate(function(res, err) {
    floodPanel.clear();
    if (err || !res || res.flood === null || res.flood === undefined) {
      floodPanel.add(ui.Label('Sentinel-1 data unavailable for this region/year.', {color: 'red'}));
      lastFlood = null;
      return;
    }
    var km2 = (res.flood / 1e6).toFixed(2);
    var pct = (res.flood / res.aoi * 100).toFixed(2);
    lastFlood = {km2: km2, pct: pct};

    floodPanel.add(ui.Label('Waterlogged Area: ' + km2 + ' km2 (' + pct + '% of region)', {fontWeight: 'bold', color: '#006064'}));
    floodPanel.add(ui.Label('Method: Sentinel-1 VV radar, pre-monsoon (Mar-May) vs monsoon (Jul-Sep) ' + yearVal + '. Permanent water and steep slopes excluded.', {fontSize: '11px', color: '#455a64'}));
    floodPanel.add(ui.Label('Note: dense built-up areas may be under-detected by radar. Toggle the layer to view.', {fontSize: '11px', fontStyle: 'italic', color: '#455a64'}));
  });

  // ---- Scorecard statistics ----
  // ---- Carbon / sapling estimate: AREA-BASED ----
  // Plantable land = open grassland or bare/sparse ground (ESA WorldCover classes 30 and 60)
  // that currently has low green cover (NDVI < target). Built-up land, farmland and water are excluded.
  var worldCover = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map');
  var plantableMask = ndvi.lt(GREEN_TARGET_NDVI).and(worldCover.eq(30).or(worldCover.eq(60)));
  var plantableArea = ee.Image.pixelArea().updateMask(plantableMask).reduceRegion({
    reducer: ee.Reducer.sum(), geometry: geometry, scale: 30, maxPixels: 1e9, bestEffort: true
  }).get('area');
  var lowGreenArea = ee.Image.pixelArea().updateMask(ndvi.lt(GREEN_TARGET_NDVI).and(ndwi.lt(0))).reduceRegion({
    reducer: ee.Reducer.sum(), geometry: geometry, scale: 100, maxPixels: 1e9, bestEffort: true
  }).get('area');

  ee.Dictionary({plantable: plantableArea, lowGreen: lowGreenArea, aoi: geometry.area(1)}).evaluate(function(res, err) {
    carbonPanel.clear();
    if (err || !res || res.plantable === null || res.plantable === undefined) {
      carbonPanel.add(ui.Label('Planting estimate unavailable for this region/year.', {color: 'red'}));
      return;
    }
    var plantHa = res.plantable / 10000;
    var lowGreenHa = (res.lowGreen || 0) / 10000;
    var lowGreenPct = res.lowGreen ? (res.lowGreen / res.aoi * 100) : 0;
    var trees = Math.round(plantHa * TREES_PER_HA * SURVIVAL_RATE);
    var co2Low = Math.round(trees * CO2_KG_LOW / 1000);
    var co2High = Math.round(trees * CO2_KG_HIGH / 1000);

    lastCarbon = {
      trees: trees.toLocaleString(),
      co2: co2Low.toLocaleString() + ' to ' + co2High.toLocaleString()
    };
    if (lastSummary) { lastSummary.trees = lastCarbon.trees; lastSummary.co2 = lastCarbon.co2; }

    carbonPanel.add(ui.Label('Low-green area (NDVI < ' + GREEN_TARGET_NDVI + ', excl. water): ' + Math.round(lowGreenHa).toLocaleString() + ' ha (' + lowGreenPct.toFixed(1) + '% of region)',
      {fontWeight: 'bold', color: '#01579b'}));
    carbonPanel.add(ui.Label('Plantable open land (grass / bare, low green): ' + Math.round(plantHa).toLocaleString() + ' ha',
      {fontWeight: 'bold', color: '#01579b'}));
    carbonPanel.add(ui.Label('Estimated saplings that survive: ~' + lastCarbon.trees,
      {fontWeight: 'bold', color: '#01579b'}));
    carbonPanel.add(ui.Label('CO2 offset potential: ~' + lastCarbon.co2 + ' t CO2/yr (mature trees)',
      {fontWeight: 'bold', color: '#00695c'}));
    carbonPanel.add(ui.Label('Assumptions: ' + TREES_PER_HA + ' trees/ha, ' + (SURVIVAL_RATE * 100) + '% survival, ' + CO2_KG_LOW + '-' + CO2_KG_HIGH + ' kg CO2/tree/yr. Land cover: ESA WorldCover 2021. Screening-level estimate, not a measurement. Street trees and rooftops are not counted.',
      {fontSize: '10px', color: '#455a64'}));
  });

  var stats = ee.Image.cat([ndvi, ndwi, ndbi, lst]).reduceRegion({
    reducer: ee.Reducer.mean(),
    geometry: geometry,
    scale: 250,
    maxPixels: 1e9
  });

  stats.evaluate(function(result) {
    statsPanel.clear();
    aiInsightsPanel.clear();
    
    if (result) {
      var meanNdvi = result.NDVI !== undefined && result.NDVI !== null ? result.NDVI.toFixed(3) : 'N/A';
      var meanNdwi = result.NDWI !== undefined && result.NDWI !== null ? result.NDWI.toFixed(3) : 'N/A';
      var meanNdbi = result.NDBI !== undefined && result.NDBI !== null ? result.NDBI.toFixed(3) : 'N/A';
      var meanLst  = result.LST  !== undefined && result.LST !== null ? result.LST.toFixed(2)  : 'N/A';

      statsPanel.add(ui.Label('Green Cover (NDVI): ' + meanNdvi, {fontWeight: 'bold', color: '#1b5e20'}));
      statsPanel.add(ui.Label('Water Index (NDWI): ' + meanNdwi, {fontWeight: 'bold', color: '#0d47a1'}));
      statsPanel.add(ui.Label('Concrete Density (NDBI): ' + meanNdbi, {fontWeight: 'bold', color: '#b71c1c'}));
      statsPanel.add(ui.Label('Surface Temperature (LST): ' + meanLst + ' C', {fontWeight: 'bold', color: '#e65100'}));

      var n = parseFloat(meanNdvi);
      var b = parseFloat(meanNdbi);
      
      var grade = 'B (Moderate Eco-Balance)';
      var advice = 'Balanced urban-eco transition observed. Maintain green patches.';

      var isUrbanMetro = (regionName.indexOf('Delhi') !== -1 || 
                         regionName.indexOf('Mumbai') !== -1 || 
                         regionName.indexOf('Bengaluru') !== -1 || 
                         regionName.indexOf('Chennai') !== -1 || 
                         regionName.indexOf('Kolkata') !== -1 || 
                         regionName.indexOf('London') !== -1 || 
                         regionName.indexOf('NYC') !== -1 || 
                         regionName.indexOf('Tokyo') !== -1 || 
                         regionName.indexOf('Beijing') !== -1);

      if (!isNaN(n) && !isNaN(b)) {
        if (isUrbanMetro) {
          if (n > 0.20 && b < (n + 0.15)) {
            grade = 'A- (Optimized Urban Eco-Integration)';
            advice = 'Metropolitan area shows commendable urban forestry and park maintenance.';
          } else if (b > (n + 0.20)) {
            grade = 'C+ (High Urban Heat & Concrete Stress)';
            advice = 'Heavy concrete footprint. Recommendation: Vertical gardens and cool-roof policies.';
          } else {
            grade = 'B+ (Standard Urban Development)';
            advice = 'Typical metropolitan land cover. Focus on pocket parks.';
          }
        } else {
          if (n > 0.35 && b < 0.10) {
            grade = 'A+ (Highly Sustainable / Carbon Sink)';
            advice = 'Ecosystem thriving with robust vegetation cover.';
          } else if (b > n) {
            grade = 'C (Concrete Dominance / Heat Risk)';
            advice = 'Built-up density exceeds vegetation. Afforestation required.';
          } else {
            grade = 'B (Stable Ecological Zone)';
            advice = 'Ecoregion in steady state.';
          }
        }
      }

      aiInsightsPanel.add(ui.Label('Eco-Health Status: ' + grade, {fontWeight: 'bold', color: '#d84315'}));
      aiInsightsPanel.add(ui.Label('AI Mitigation Advice: ' + advice, {fontSize: '11px', fontStyle: 'italic', color: '#37474f'}));

      var logEntry = regionName.substring(0, 14) + ' (' + yearVal + ') | Grade: ' + grade.substring(0, 2);
      searchHistory.unshift(logEntry);
      if (searchHistory.length > 5) { searchHistory.pop(); }

      historyPanel.clear();
      for (var i = 0; i < searchHistory.length; i++) {
        historyPanel.add(ui.Label((i+1) + '. ' + searchHistory[i], {fontSize: '11px', margin: '2px 0', color: '#37474f'}));
      }

      lastSummary = {
        r: regionName,
        y: String(yearVal),
        ndvi: meanNdvi,
        ndwi: meanNdwi,
        ndbi: meanNdbi,
        lst: meanLst,
        grade: grade,
        advice: advice,
        trees: lastCarbon ? lastCarbon.trees : 'still computing',
        co2: lastCarbon ? lastCarbon.co2 : 'still computing'
      };
      geminiAnswerBox.setValue('Ready! Click "Ask Gemini AI Now" for automated insights.');

    } else {
      statsPanel.add(ui.Label('Data unavailable.', {color: 'red'}));
      aiInsightsPanel.add(ui.Label('Insights unavailable.', {color: 'red'}));
      lastSummary = null;
      geminiAnswerBox.setValue('Data computation failed.');
    }
  });

  // ---- Longitudinal NDVI chart: same helper, same cloud filter, same scale ----
  var years = ee.List.sequence(2020, 2026);
  var featureList = years.map(function(y) {
    y = ee.Number(y);
    var start = ee.Date.fromYMD(y, 1, 1);
    var end = ee.Date.fromYMD(y.add(1), 1, 1);   // full year (old code skipped 31 Dec)
    
    var yearNdvi = getS2Median(geometry, start, end)
      .normalizedDifference(['B8', 'B4']).rename('NDVI');

    var meanVal = yearNdvi.reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: geometry,
      scale: 250,
      maxPixels: 1e9
    }).get('NDVI');
    
    return ee.Feature(null, {
      'year': y.format('%d'),       // string, so axis shows 2020 not 2,020
      'NDVI': meanVal
    });
  });
  
  var yearlyFeatureCollection = ee.FeatureCollection(featureList);

  var chart = ui.Chart.feature.byFeature(yearlyFeatureCollection, 'year', ['NDVI'])
    .setChartType('LineChart')
    .setOptions({
      title: 'Longitudinal NDVI Trend (2020 - 2026), cloud < ' + CLOUD_MAX + '%',
      vAxis: {title: 'Mean NDVI Index'},
      hAxis: {title: 'Year'},
      series: {0: {color: '#2e7d32', lineWidth: 3, pointsVisible: true}},
      backgroundColor: '#ffffff',
      legend: {position: 'none'}
    });
    
  chartPanel.clear();
  chartPanel.add(chart);
};

updateDashboard(currentAoi, currentYear, currentKey);

ui.root.clear();
ui.root.add(controlPanel);
ui.root.add(map);
