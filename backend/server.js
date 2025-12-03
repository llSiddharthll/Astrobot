import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
app.use(cors()); // Allow all origins
app.use(express.json());

let cachedToken = null;
let tokenExpiry = null;

// Helper: Get access token
async function getProkeralaToken() {
  try {
    const clientId = process.env.PROKERALA_CLIENT_ID;
    const clientSecret = process.env.PROKERALA_CLIENT_SECRET;

    const now = Math.floor(Date.now() / 1000);

    // If cached token is still valid → return it
    if (cachedToken && tokenExpiry && now < tokenExpiry) {
      return cachedToken;
    }

    // Prepare token request
    const params = new URLSearchParams();
    params.append("grant_type", "client_credentials");
    params.append("client_id", clientId);
    params.append("client_secret", clientSecret);

    const response = await fetch("https://api.prokerala.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });

    const data = await response.json();

    if (!data.access_token) {
      throw new Error("Failed to generate token");
    }

    // Save token & expiry (minus 30s for safety)
    cachedToken = data.access_token;
    tokenExpiry = now + (data.expires_in - 30);

    return cachedToken;

  } catch (err) {
    console.error("Token Error:", err);
    throw err;
  }
}

// Route to generate or return cached token
app.get("/token", async (req, res) => {
  try {
    const token = await getProkeralaToken();
    res.json({
      access_token: token,
      cached: true
    });
  } catch (err) {
    console.error("Token Error:", err);
    res.status(500).json({ error: "Internal Server Error", details: err.message });
  }
});

// New: Geocoding endpoint
app.get("/geocode", async (req, res) => {
  try {
    const { place } = req.query;
    
    if (!place) {
      return res.status(400).json({ error: "Place parameter is required" });
    }

    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(place)}`,
      {
        headers: {
          "User-Agent": "Adhyatmanii-Kundli-App/1.0"
        }
      }
    );

    if (!response.ok) {
      throw new Error("Geocoding API failed");
    }

    const data = await response.json();

    if (!data.length) {
      return res.status(404).json({ error: "Place not found" });
    }

    const lat = parseFloat(data[0].lat).toFixed(4);
    const lon = parseFloat(data[0].lon).toFixed(4);

    res.json({
      coordinates: `${lat},${lon}`,
      location: data[0].display_name,
      latitude: lat,
      longitude: lon
    });

  } catch (err) {
    console.error("Geocode Error:", err);
    res.status(500).json({ error: "Internal Server Error", details: err.message });
  }
});

// New: Kundli chart generation endpoint
app.post("/generate-kundli", async (req, res) => {
  try {
    const { datetime, coordinates, chart_type = "lagna", chart_style = "north-indian" } = req.body;

    if (!datetime || !coordinates) {
      return res.status(400).json({ error: "datetime and coordinates are required" });
    }

    // Get access token
    const accessToken = await getProkeralaToken();

    // FOR SANDBOX MODE: Extract time from original datetime, but use January 1st
    // Original format: "1995-12-25T14:30:00+05:30"
    const originalDate = new Date(datetime);
    const year = originalDate.getFullYear();
    const hours = originalDate.getHours().toString().padStart(2, '0');
    const minutes = originalDate.getMinutes().toString().padStart(2, '0');
    const seconds = originalDate.getSeconds().toString().padStart(2, '0');
    
    // Use January 1st for sandbox mode (required by Prokerala free tier)
    const sandboxDatetime = `${year}-01-01T${hours}:${minutes}:${seconds}+05:30`;

    // Prepare API request to Prokerala
    const params = new URLSearchParams({
      ayanamsa: "1",
      coordinates: coordinates,
      datetime: sandboxDatetime, // Use sandbox date instead of original
      chart_type: chart_type,
      chart_style: chart_style,
      format: "svg"
    });

    const response = await fetch(`https://api.prokerala.com/v2/astrology/chart?${params.toString()}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "text/plain,application/json" // Accept both text and JSON
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Prokerala API failed: ${response.status} - ${errorText}`);
    }

    // Check content type to determine if response is SVG or JSON
    const contentType = response.headers.get('content-type');
    let result = {};

    if (contentType && contentType.includes('application/json')) {
      // Handle JSON response
      const data = await response.json();
      result = {
        svg: data?.data?.svg || null,
        houseData: data?.data?.house || [],
        mangalDosha: data?.data?.mangal_dosha || {},
        kaalSarpDosha: data?.data?.kaal_sarp_dosha || {},
        pitraDosha: data?.data?.pitra_dosha || {},
        sadeSati: data?.data?.sade_sati || {},
        planets: extractPlanetsFromHouses(data?.data?.house || []),
        success: true,
        isSandboxMode: true,
        responseType: 'json'
      };
    } else {
      // Handle direct SVG response
      const svgText = await response.text();
      result = {
        svg: svgText,
        houseData: [],
        mangalDosha: {},
        kaalSarpDosha: {},
        pitraDosha: {},
        sadeSati: {},
        planets: {},
        success: true,
        isSandboxMode: true,
        responseType: 'svg'
      };
    }

    res.json(result);

  } catch (err) {
    console.error("Kundli Generation Error:", err);
    res.status(500).json({ 
      error: "Failed to generate Kundli chart", 
      details: err.message,
      success: false 
    });
  }
});

// Helper: Extract planets from house data
function extractPlanetsFromHouses(houseData) {
  const planetMap = {};
  
  if (Array.isArray(houseData)) {
    houseData.forEach(house => {
      if (house.planets && Array.isArray(house.planets)) {
        house.planets.forEach(planet => {
          if (planet.name) {
            planetMap[planet.name] = house.house_id;
          }
        });
      }
    });
  }
  
  return planetMap;
}

app.get("/", (req, res) => {
  res.send("Adhyatmanii Kundli Backend is Running");
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});