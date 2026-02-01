
import { GoogleGenAI } from "@google/genai";

const getAI = () => new GoogleGenAI({ apiKey: process.env.API_KEY });

export const searchDriveAssist = async (query: string, location?: { lat: number, lng: number }) => {
  const ai = getAI();
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-lite-latest',
    contents: { parts: [{ text: query }] },
    config: {
      tools: [{ googleSearch: {} }, { googleMaps: {} }],
      toolConfig: { retrievalConfig: { latLng: { latitude: location?.lat || 52, longitude: location?.lng || 4 } } }
    },
  });
  return { text: response.text, sources: response.candidates?.[0]?.groundingMetadata?.groundingChunks };
};

export const chatWithGemini = async (message: string) => {
  const ai = getAI();
  return ai.models.generateContentStream({
    model: 'gemini-3-flash-preview',
    contents: { parts: [{ text: message }] },
    config: { systemInstruction: "Je bent DriveAssist co-piloot. Help de chauffeur kort en bondig." }
  });
};

export const generateImage = async (prompt: string, aspectRatio: "1:1" | "16:9" | "9:16") => {
  const ai = getAI();
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: { parts: [{ text: prompt }] },
    config: { imageConfig: { aspectRatio } },
  });
  const part = response.candidates?.[0]?.content?.parts.find(p => p.inlineData);
  if (part?.inlineData) return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
  throw new Error("Geen afbeelding.");
};

export const generateVideo = async (prompt: string) => {
  const ai = getAI();
  let operation = await ai.models.generateVideos({
    model: 'veo-3.1-fast-generate-preview',
    prompt,
    config: { numberOfVideos: 1, resolution: '720p', aspectRatio: '16:9' }
  });
  while (!operation.done) {
    await new Promise(r => setTimeout(r, 8000));
    operation = await ai.operations.getVideosOperation({ operation });
  }
  const link = operation.response?.generatedVideos?.[0]?.video?.uri;
  return `${link}&key=${process.env.API_KEY}`;
};
