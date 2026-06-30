export interface LocationData {
  city: string;
  region: string;
  country: string;
  latitude: number;
  longitude: number;
  precision: 'precise' | 'approximate';
}

export async function getUserLocation(): Promise<LocationData | null> {
  const getGpsLocation = (): Promise<GeolocationPosition> => {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("Geolocation not supported"));
      } else {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 5000,
          maximumAge: 0
        });
      }
    });
  };

  try {
    const position = await getGpsLocation();
    const lat = position.coords.latitude;
    const lon = position.coords.longitude;
    
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`, {
        headers: {
          'User-Agent': 'OriaAssistant/1.0'
        }
      });
      const data = await response.json();
      
      return {
        city: data.address?.city || data.address?.town || data.address?.village || data.address?.municipality || 'Unknown',
        region: data.address?.state || data.address?.region || data.address?.county || 'Unknown',
        country: data.address?.country || 'Unknown',
        latitude: lat,
        longitude: lon,
        precision: 'precise'
      };
    } catch (e) {
      console.warn("Reverse geocoding failed, falling back to basic coords", e);
      return {
        city: 'Unknown',
        region: 'Unknown',
        country: 'Unknown',
        latitude: lat,
        longitude: lon,
        precision: 'precise'
      };
    }
  } catch (gpsError) {
    console.warn("GPS Location failed, falling back to IP based location", gpsError);
    try {
      const ipResponse = await fetch('https://ipapi.co/json/');
      const ipData = await ipResponse.json();
      
      if (ipData.error) {
        throw new Error("IP Location API returned an error");
      }

      return {
        city: ipData.city || 'Unknown',
        region: ipData.region || 'Unknown',
        country: ipData.country_name || 'Unknown',
        latitude: ipData.latitude || 0,
        longitude: ipData.longitude || 0,
        precision: 'approximate'
      };
    } catch (ipError) {
      console.error("IP Location failed as well", ipError);
      return null;
    }
  }
}
