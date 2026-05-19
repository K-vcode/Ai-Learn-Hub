require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { GoogleGenAI } = require("@google/genai");
const axios = require("axios");
const Groq = require("groq-sdk");
const FormData = require('form-data');
const { pipeline } = require("@xenova/transformers");
const fs = require('fs');
const path = require('path');
const os = require('os');
const app = express();

const languageMap = { en: "English", ta: "Tamil", hi: "Hindi" };

const getTargetLanguage = (language) => languageMap[language] || "English";

const getNumberedOcrLines = (text) => text
  .split(/\r?\n/)
  .map((line) => line.replace(/\s+/g, " ").trim())
  .filter(Boolean)
  .map((line, index) => `${index + 1}. ${line}`)
  .join("\n");

const buildImageContentPrompt = ({ extractedText, userPrompt, language }) => {
  const targetLang = getTargetLanguage(language);
  const numberedLines = getNumberedOcrLines(extractedText);
  const answerStructure = language === "ta"
    ? `பதில் அமைப்பு:
1. படத்தில் இருந்து படிக்கப்பட்ட வரி அல்லது உரை
2. அந்த உரை எந்த விஷயத்தைப் பற்றி சொல்கிறது
3. எளிய தமிழில் தெளிவான விளக்கம்
4. பயனர் கேட்ட கேள்விக்கான நேரடி பதில்`
    : `Return the answer in this structure:
1. Extracted text
2. What this content is about
3. Clear detailed explanation
4. Direct answer to the user's request, if any`;
  const questionLine = userPrompt
    ? `User question/request: ${userPrompt}`
    : "User request: Explain the visible text and its meaning clearly.";

  return {
    system: `You are an OCR-based study assistant. Work only from the OCR text provided by the backend.
Do not give generic image descriptions such as "this is a white paper with text".
First understand the actual topic, then explain the content clearly.
If the OCR text contains notes, questions, diagrams, formulas, equations, lists, or handwritten content, identify the content type and explain the real meaning.
The OCR text is also provided as numbered lines. If the user asks for a specific line, such as "4th line", identify that exact numbered line first and explain only that line unless the surrounding context is needed.
If any OCR text looks misspelled or broken, infer the most likely intended meaning carefully, but do not invent content that is not supported by the OCR.
Respond in ${targetLang}.
If responding in Tamil, use simple, natural Tamil sentences suitable for text-to-speech. Avoid unnecessary English headings, markdown symbols, and long complex sentences.`,
    user: `OCR text extracted from the image:

${extractedText}

Numbered OCR lines:

${numberedLines || "No separate lines detected."}

${questionLine}

${answerStructure}`
  };
};


const allowedOrigins = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://192.168.1.105:3000",
  "http://192.168.1.105:5000",
  "http://10.76.134.9:3000",
  "http://10.76.134.9:5000",
  "https://localhost",
  "http://localhost",
  "capacitor://localhost",
  "ionic://localhost",
  ...(process.env.CLIENT_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
]);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked origin: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  credentials: true
}));
app.options(/.*/, cors());


app.use(express.json({ limit: '10mb' }));

// ==========================
//  MONGODB CONNECTION
// ==========================
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("âœ… MongoDB Connected"))
.catch(err => console.log("âŒ MongoDB Error:", err));

// ==========================
//  USER SCHEMA
// ==========================
const UserSchema = new mongoose.Schema({
  fullname: String,
  email: { type: String, unique: true },
  username: { type: String, unique: true },
  password: String
});
const User = mongoose.model("User", UserSchema);

// ==========================
//  SCOREBOARD SCHEMA
// ==========================
const QuizAttemptSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username: { type: String, required: true },
  quizTitle: { type: String, required: true },
  difficulty: { type: String, required: true },
  score: { type: Number, required: true },
  totalQuestions: { type: Number, required: true },
  percentage: { type: Number, required: true },
  answers: { type: Array, default: [] },
  completedAt: { type: Date, default: Date.now }
});
const QuizAttempt = mongoose.model("QuizAttempt", QuizAttemptSchema);

const chatHistorySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  question: String,
  answer: String,
  language: String,
  hasImage: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
chatHistorySchema.index({ user: 1, createdAt: -1 });
const ChatHistory = mongoose.model("ChatHistory", chatHistorySchema);

// ==========================
// 🔐 AUTHENTICATION MIDDLEWARE
// ==========================
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.split(" ")[1] : null;
  if (!token) return res.status(401).json({ success: false, error: "Unauthorized" });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch {
    res.status(401).json({ success: false, error: "Invalid token" });
  }
};

// ==========================
// ðŸ” SIGNUP API
// ==========================
app.post("/api/signup", async (req, res) => {
  try {
    const { fullname, email, username, password } = req.body;
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) return res.status(400).json({ message: "User already exists" });
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ fullname, email, username, password: hashedPassword });
    await newUser.save();
    res.status(201).json({ message: "Signup successful" });
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ==========================
// ðŸ” LOGIN API
// ==========================
app.post("/api/login", async (req, res) => {
  try {
    const { email, username, password } = req.body;
    const loginValue = username || email;
    const user = await User.findOne({ 
      $or: [
        { email: { $regex: new RegExp(`^${loginValue}$`, 'i') } },
        { username: { $regex: new RegExp(`^${loginValue}$`, 'i') } }
      ]
    });
    if (!user) return res.status(400).json({ message: "Invalid email/username or password" });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: "Invalid email/username or password" });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "1d" });
    res.json({ success: true, message: "Login successful", token, user: { id: user._id, username: user.username, email: user.email, fullname: user.fullname } });
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ==========================
// ðŸ¤– GROQ AI SETUP
// ==========================
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ==========================
// ðŸ¤– AI CONTENT GENERATION API (language aware)
// ==========================
app.post("/api/generate-content", async (req, res) => {
  try {
    const { prompt, image, language = "en" } = req.body;
    if (!prompt && !image) return res.status(400).json({ success: false, error: "Please provide input" });
    let finalPrompt = prompt || "";
    const languageNames = { en: "English", ta: "Tamil", hi: "Hindi" };
    const targetLang = languageNames[language] || "English";
    const systemMessage = `You are a helpful AI assistant. Always respond in ${targetLang} language only. Do not mix languages. If the user asks in English but the target language is ${targetLang}, still respond in ${targetLang}.`;
    const chatCompletion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "system", content: systemMessage }, { role: "user", content: finalPrompt }]
    });
    res.json({ success: true, result: chatCompletion.choices[0].message.content });
  } catch (err) {
    console.log("âŒ ERROR:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================
// ðŸ–¼ï¸ FREE OCR API WITH AI
// ==========================
app.post("/api/analyze-image", async (req, res) => {
  try {
    const { imageBase64, prompt, language } = req.body;
    if (!imageBase64) return res.status(400).json({ success: false, error: "Image is required" });
    console.log("ðŸ” Analyzing image with free OCR.space API...");
    const formData = new FormData();
    formData.append('base64Image', `data:image/jpeg;base64,${imageBase64}`);
    formData.append('apikey', 'helloworld');
    formData.append('language', 'eng');
    formData.append('isOverlayRequired', 'false');
    const response = await axios.post('https://api.ocr.space/parse/image', formData, { headers: formData.getHeaders() });
    const extractedText = response.data.ParsedResults?.[0]?.ParsedText || "No text found";
    console.log("âœ… Text extracted successfully");
    if (prompt && extractedText !== "No text found") {
      let aiPrompt = `${prompt}\n\nHere is the text extracted from the image:\n\n${extractedText}`;
      if (!prompt || prompt.trim() === "") aiPrompt = `Please analyze and explain the following text extracted from an image:\n\n${extractedText}`;
      const chatCompletion = await groq.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [{ role: "system", content: "You are an AI assistant that helps analyze text extracted from images." }, { role: "user", content: aiPrompt }],
        temperature: 0.7, max_tokens: 2000
      });
      const aiResponse = chatCompletion.choices[0].message.content;
      return res.json({ success: true, extractedText, aiAnalysis: aiResponse, raw: response.data });
    }
    res.json({ success: true, extractedText, text: extractedText, raw: response.data });
  } catch (error) {
    console.error("âŒ OCR Error:", error.response?.data || error.message);
    res.status(500).json({ success: false, error: "Image analysis failed", details: error.message });
  }
});

// ==========================
// ðŸ–¼ï¸ IMAGE + AI COMBINED ANALYSIS
// ==========================
app.post("/api/analyze-image-with-ai", async (req, res) => {
  try {
    const { imageBase64, prompt, language, specificTask } = req.body;
    if (!imageBase64) return res.status(400).json({ success: false, error: "Image is required" });
    const formData = new FormData();
    formData.append('base64Image', `data:image/jpeg;base64,${imageBase64}`);
    formData.append('apikey', 'helloworld');
    formData.append('language', 'eng');
    formData.append('isOverlayRequired', 'false');
    const ocrResponse = await axios.post('https://api.ocr.space/parse/image', formData, { headers: formData.getHeaders() });
    const extractedText = ocrResponse.data.ParsedResults?.[0]?.ParsedText || "";
    if (!extractedText || extractedText === "No text found") return res.json({ success: false, error: "No text found in the image", extractedText: "" });
    let aiPrompt = "", systemMessage = "";
    if (specificTask === "explain") { systemMessage = "You are an expert at explaining text."; aiPrompt = `Please explain:\n${extractedText}`; }
    else if (specificTask === "summarize") { systemMessage = "You are an expert at summarizing."; aiPrompt = `Summarize:\n${extractedText}`; }
    else if (specificTask === "quiz") { systemMessage = "Expert quiz generator."; aiPrompt = `Create 5 MCQs from:\n${extractedText}`; }
    else if (specificTask === "translate") { const targetLang = language || "English"; systemMessage = "Translator."; aiPrompt = `Translate to ${targetLang}:\n${extractedText}`; }
    else { systemMessage = "Helpful AI assistant."; aiPrompt = prompt ? `${prompt}\n\nText:\n${extractedText}` : `Analyze:\n${extractedText}`; }
    const chatCompletion = await groq.chat.completions.create({ model: "llama-3.1-8b-instant", messages: [{ role: "system", content: systemMessage }, { role: "user", content: aiPrompt }], temperature: 0.7, max_tokens: 4000 });
    let parsedResponse = chatCompletion.choices[0].message.content;
    try { if (parsedResponse.trim().startsWith('{') || parsedResponse.trim().startsWith('[')) parsedResponse = JSON.parse(parsedResponse); } catch(e) {}
    res.json({ success: true, extractedText, result: parsedResponse, task: specificTask || "analysis" });
  } catch (error) {
    console.error("âŒ Error:", error.response?.data || error.message);
    res.status(500).json({ success: false, error: "Analysis failed", details: error.message });
  }
});

// ==========================
// ðŸ“ NOTE2QUIZ - GENERATE QUIZ FROM NOTES
// ==========================
app.post("/api/generate-quiz", async (req, res) => {
  try {
    const { notes, difficulty } = req.body;
    if (!notes || notes.trim().length === 0) return res.status(400).json({ success: false, error: "Notes are required" });
    let difficultyPrompt = "", numQuestions = 5;
    if (difficulty === 'easy') { difficultyPrompt = "Create basic questions."; numQuestions = 5; }
    else if (difficulty === 'medium') { difficultyPrompt = "Create moderate questions."; numQuestions = 7; }
    else if (difficulty === 'hard') { difficultyPrompt = "Create challenging questions."; numQuestions = 10; }
    else { difficultyPrompt = "Create moderate questions."; numQuestions = 5; }
    const prompt = `Based on notes, generate a quiz with ${numQuestions} MCQs. Difficulty: ${difficulty}. Return ONLY valid JSON. Format: {"title":"...","difficulty":"${difficulty}","questions":[{"id":1,"text":"...","options":["..."],"correct":0,"explanation":"..."}]}\n\nNotes:\n${notes}`;
    const chatCompletion = await groq.chat.completions.create({ model: "llama-3.1-8b-instant", messages: [{ role: "system", content: "Expert quiz generator. Return only valid JSON." }, { role: "user", content: prompt }], temperature: 0.7, max_tokens: 4000 });
    let responseText = chatCompletion.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonStart = responseText.indexOf('{'), jsonEnd = responseText.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1) responseText = responseText.substring(jsonStart, jsonEnd + 1);
    responseText = responseText.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    let quizData = JSON.parse(responseText);
    if (!quizData.questions || !Array.isArray(quizData.questions)) throw new Error("Invalid format");
    quizData.questions = quizData.questions.map((q, i) => ({ id: q.id || i+1, text: q.text || q.question || "Missing", options: q.options || ["A","B","C","D"], correct: q.correct !== undefined ? q.correct : 0, explanation: q.explanation || "No explanation" }));
    res.json({ success: true, quiz: quizData });
  } catch (error) {
    console.error("âŒ Quiz generation error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================
// ðŸ“Š SCOREBOARD API ENDPOINTS
// ==========================
app.post("/api/save-quiz-score", async (req, res) => {
  try {
    const { userId, username, quizTitle, difficulty, score, totalQuestions, percentage, answers } = req.body;
    if (!userId || !username || !quizTitle) return res.status(400).json({ success: false, error: "Missing required fields" });
    const quizAttempt = new QuizAttempt({ userId, username, quizTitle, difficulty: difficulty || "Medium", score, totalQuestions, percentage, answers: answers || [] });
    await quizAttempt.save();
    res.json({ success: true, message: "Score saved", attempt: quizAttempt });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});
app.get("/api/get-quiz-scores", async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, error: "Authentication required" });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const scores = await QuizAttempt.find({ userId: decoded.id }).sort({ completedAt: -1 });
    res.json({ success: true, scores });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});
app.delete("/api/clear-quiz-history", async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, error: "Authentication required" });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    await QuizAttempt.deleteMany({ userId: decoded.id });
    res.json({ success: true, message: "History cleared" });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/chat/save', authMiddleware, async (req, res) => {
  try {
    const { question, answer, language, hasImage } = req.body;
    if (!question || !answer) return res.status(400).json({ success: false, error: 'Missing chat data' });
    const chatEntry = new ChatHistory({
      user: req.userId,
      question,
      answer,
      language: language || 'en',
      hasImage: Boolean(hasImage)
    });
    await chatEntry.save();
    res.json({ success: true, chat: chatEntry });
  } catch (error) {
    console.error('Chat save error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/chat/history', authMiddleware, async (req, res) => {
  try {
    const history = await ChatHistory.find({ user: req.userId }).sort({ createdAt: -1 }).limit(50);
    res.json(history);
  } catch (error) {
    console.error('Chat history fetch error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/chat/history', authMiddleware, async (req, res) => {
  try {
    await ChatHistory.deleteMany({ user: req.userId });
    res.json({ success: true, message: 'Chat history cleared' });
  } catch (error) {
    console.error('Chat history clear error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/chat/history/:id', authMiddleware, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Invalid chat item id' });
    }
    const deleted = await ChatHistory.findOneAndDelete({ _id: req.params.id, user: req.userId });
    if (!deleted) return res.status(404).json({ success: false, error: 'Chat item not found' });
    res.json({ success: true, message: 'Chat item deleted' });
  } catch (error) {
    console.error('Chat delete error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================
// ðŸ”— SHARED QUIZ ROUTE
// ==========================
app.post("/api/shared-quiz", async (req, res) => {
  try {
    const { encodedData } = req.body;
    if (!encodedData) return res.status(400).json({ success: false, error: "No quiz data provided" });
    const decodedData = Buffer.from(encodedData, 'base64').toString('utf-8');
    const quizData = JSON.parse(decodedData);
    res.json({ success: true, quiz: quizData });
  } catch (error) { res.status(500).json({ success: false, error: "Invalid quiz link" }); }
});

// ==========================
// ðŸ¤– LOCAL AI IMAGE MODEL (Xenova pipeline) - FALLBACK FOR VISUAL DESCRIPTION
// ==========================
let imageModel = null;
let modelLoading = false;

async function loadImageModel() {
  if (imageModel) return imageModel;
  if (modelLoading) {
    while (modelLoading) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return imageModel;
  }
  try {
    console.log("ðŸ”„ Loading image recognition model (first time: 20-30 seconds)...");
    modelLoading = true;
    imageModel = await pipeline("image-to-text", "Xenova/vit-gpt2-image-captioning");
    console.log("âœ… Image Recognition AI Model Loaded Successfully!");
  } catch (error) {
    console.error("âŒ Failed to load vision model:", error.message);
    imageModel = null;
  } finally {
    modelLoading = false;
  }
  return imageModel;
}

app.get("/", (req, res) => {
  res.json({ success: true, message: "AI Learn Hub backend is running" });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    groqConfigured: Boolean(process.env.GROQ_API_KEY),
    mongoConfigured: Boolean(process.env.MONGO_URI),
    resumePdfParser: getPdfParserMode()
  });
});

// ==========================
// ðŸ–¼ï¸ MAIN LOCAL IMAGE AI (OCR FIRST, THEN VISION FALLBACK)
// ==========================
app.post("/api/local-image-ai", async (req, res) => {
  let tempFilePath = null;
  try {
    const { imageBase64, prompt, language = "en" } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ success: false, error: "Image required" });
    }

    console.log("ðŸ” Step 1: Attempting OCR to extract text from image...");
    let base64String = imageBase64;
    if (imageBase64.includes(',')) {
      base64String = imageBase64.split(',')[1];
    }

    let extractedText = "";
    let ocrSuccess = false;

    // 1. OCR attempt
    try {
      const formData = new FormData();
      formData.append('base64Image', `data:image/jpeg;base64,${base64String}`);
      formData.append('apikey', 'helloworld');
      formData.append('language', 'eng');
      formData.append('isOverlayRequired', 'false');
      formData.append('OCREngine', '2');
      formData.append('scale', 'true');
      formData.append('detectOrientation', 'true');

      const ocrResponse = await axios.post('https://api.ocr.space/parse/image', formData, {
        headers: { ...formData.getHeaders() },
        timeout: 30000
      });
      extractedText = ocrResponse.data?.ParsedResults?.[0]?.ParsedText || "";
      extractedText = extractedText.trim();
      if (extractedText && extractedText !== "No text found" && extractedText.length > 2) {
        ocrSuccess = true;
        console.log("âœ… OCR succeeded. Extracted text length:", extractedText.length);
      } else {
        console.log("âš ï¸ OCR found little or no readable text.");
      }
    } catch (ocrErr) {
      console.log("OCR service error:", ocrErr.message);
    }

    // 2. If OCR found meaningful text â†’ explain the text content (like a teacher)
    if (ocrSuccess) {
      console.log("ðŸ“– Explaining extracted text content (no visual description)");
      const userPrompt = (prompt || "").trim();
      const contentPrompt = buildImageContentPrompt({ extractedText, userPrompt, language });

      const groqResponse = await groq.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: contentPrompt.system },
          { role: "user", content: contentPrompt.user }
        ],
        temperature: 0.7,
        max_tokens: 2500
      });
      const explanation = groqResponse.choices[0].message.content;
      return res.json({
        success: true,
        aiAnalysis: `**Extracted OCR Text**\n\n${extractedText}\n\n**Explanation**\n\n${explanation}`,
        extractedText: extractedText,
        mode: "ocr_explanation"
      });
    }

    // 3. No readable text found. Avoid generic captions for study/OCR workflows.
    console.log("No readable OCR text detected. Returning OCR-focused message.");
    const noTextMessage = "I could not extract readable text from this image. Please upload a clearer, closer image with good lighting, or crop the image around the notes/questions so I can read and explain the actual content.";
    return res.status(200).json({
      success: true,
      aiAnalysis: `**OCR Result**\n\n${noTextMessage}`,
      extractedText: "",
      mode: "ocr_no_text"
    });

    /*
    // Vision captions are intentionally disabled here because they produce generic
    // responses like "white paper with text" instead of explaining readable content.
    await loadImageModel();
    if (!imageModel) {
      return res.status(200).json({
        success: true,
        aiAnalysis: `ðŸ“· **AI Vision Model Loading**\n\nPlease wait 30 seconds and try again.`,
        loading: true
      });
    }

    // Write temp file for vision model
    const tempDir = os.tmpdir();
    tempFilePath = path.join(tempDir, `img_${Date.now()}.jpg`);
    fs.writeFileSync(tempFilePath, Buffer.from(base64String, 'base64'));

    const visionResult = await imageModel(tempFilePath);
    const shortCaption = visionResult[0].generated_text;
    console.log("âœ… Vision caption:", shortCaption);

    fs.unlinkSync(tempFilePath);
    tempFilePath = null;

    const userPrompt = (prompt || "").trim();

    // If user typed a specific question about the image, answer it using Groq + caption
    if (userPrompt) {
      const languageMap = { en: "English", ta: "Tamil", hi: "Hindi" };
      const targetLang = languageMap[language] || "English";
      const groqPrompt = `The image shows: "${shortCaption}".\nUser question: "${userPrompt}"\nPlease provide a **detailed, helpful answer** based on this visual description. Respond in ${targetLang}.`;

      const groqResponse = await groq.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: "You are a helpful assistant describing images." },
          { role: "user", content: groqPrompt }
        ],
        temperature: 0.7,
        max_tokens: 800
      });
      const answer = groqResponse.choices[0].message.content;
      return res.json({ success: true, aiAnalysis: `ðŸ“· **Image Analysis**\n\n${answer}\n\n*(visual description: ${shortCaption})*` });
    } else {
      // No text and no prompt â€“ just return short caption
      return res.json({ success: true, aiAnalysis: `ðŸ“· **Image Analysis**\n\n${shortCaption}` });
    }
    */

  } catch (error) {
    console.error("âŒ Image analysis error:", error);
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch(e) {}
    }
    res.status(200).json({
      success: false,
      error: error.message,
      aiAnalysis: "âš ï¸ Analysis failed. Please try again."
    });
  }
});

// ==========================
// ðŸ†• OCR + TRANSLATION + VOICE SUPPORT (ENHANCED)
// ==========================
async function translateText(text, targetLang) {
  if (!text || text.trim() === "" || targetLang === "en") return text;
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${targetLang}`;
    const response = await axios.get(url, { timeout: 10000 });
    let translated = response.data?.responseData?.translatedText || text;
    translated = translated.replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    return translated;
  } catch (error) {
    console.error("Translation error:", error.message);
    return text;
  }
}

app.post("/api/ocr-and-read", async (req, res) => {
  try {
    const { imageBase64, targetLang = "en" } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ success: false, error: "Image required" });
    }

    let base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;

    const formData = new FormData();
    formData.append('base64Image', `data:image/jpeg;base64,${base64Data}`);
    formData.append('apikey', 'helloworld');
    formData.append('language', 'eng');
    formData.append('isOverlayRequired', 'false');
    formData.append('OCREngine', '2');

    const ocrResponse = await axios.post('https://api.ocr.space/parse/image', formData, {
      headers: { ...formData.getHeaders() },
      timeout: 15000
    });

    let extractedText = ocrResponse.data?.ParsedResults?.[0]?.ParsedText || "";
    extractedText = extractedText.trim();
    if (extractedText === "No text found" || extractedText === "") {
      return res.json({
        success: true,
        extractedText: "",
        translatedText: "No text could be detected. Please try a clearer image with visible text.",
        targetLanguage: targetLang
      });
    }

    let translatedText = extractedText;
    if (targetLang !== "en") {
      translatedText = await translateText(extractedText, targetLang);
    }

    const explanationRes = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: "You are an expert teacher. Explain poems and text in a very detailed, simple, and easy-to-understand way." },
        { role: "user", content: `Explain this clearly in full detail:\n\n${translatedText}` }
      ],
      temperature: 0.7,
      max_tokens: 2000
    });

    res.json({
      success: true,
      extractedText: extractedText,
      translatedText: translatedText,
      explanation: explanationRes.choices[0].message.content,
      targetLanguage: targetLang
    });
  } catch (error) {
    console.error("âŒ OCR error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});
// ==========================
// ðŸŽ¤ ASK ABOUT IMAGE (voice assistant uses this)
// ==========================
app.post("/api/ask-about-image", async (req, res) => {
  try {
    const { imageBase64, question, language = "en" } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ success: false, error: "Image required" });
    }
    if (!question || question.trim() === "") {
      return res.status(400).json({ success: false, error: "Question required" });
    }

    console.log("ðŸŽ¤ Voice assistant question:", question);
    let base64String = imageBase64;
    if (imageBase64.includes(',')) base64String = imageBase64.split(',')[1];

    // ---- Step 1: Extract text from image using OCR ----
    let extractedText = "";
    let ocrSuccess = false;
    try {
      const formData = new FormData();
      formData.append('base64Image', `data:image/jpeg;base64,${base64String}`);
      formData.append('apikey', 'helloworld');
      formData.append('language', 'eng');
      formData.append('isOverlayRequired', 'false');
      formData.append('OCREngine', '2');
      formData.append('scale', 'true');
      formData.append('detectOrientation', 'true');
      const ocrResponse = await axios.post('https://api.ocr.space/parse/image', formData, {
        headers: { ...formData.getHeaders() },
        timeout: 30000
      });
      extractedText = ocrResponse.data?.ParsedResults?.[0]?.ParsedText || "";
      extractedText = extractedText.trim();
      if (extractedText && extractedText !== "No text found" && extractedText.length > 2) {
        ocrSuccess = true;
        console.log("âœ… OCR extracted text length:", extractedText.length);
      }
    } catch (err) {
      console.log("OCR error:", err.message);
    }

    if (!ocrSuccess) {
      return res.json({
        success: true,
        answer: "I could not extract readable text from this image. Please upload a clearer, closer image or crop the image around the notes/questions, then ask again.",
        hasText: false,
        extractedText: ""
      });
    }

    // ---- Step 2: Let Groq answer the question based on the OCR text ----
    const contentPrompt = buildImageContentPrompt({ extractedText, userPrompt: question, language });

    const groqResponse = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: contentPrompt.system },
        { role: "user", content: contentPrompt.user }
      ],
      temperature: 0.7,
      max_tokens: 1500
    });

    const answer = groqResponse.choices[0].message.content;
    res.json({ success: true, answer, hasText: true, extractedText });

  } catch (error) {
    console.error("âŒ Ask about image error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});
// ==================== RESUME ANALYZER (NO API KEY) ====================

const multer = require("multer");
const pdfParseModule = require("pdf-parse");
const mammoth = require("mammoth");

const getPdfParserMode = () => {
  if (typeof pdfParseModule === "function") return "legacy-function";
  if (typeof pdfParseModule?.default === "function") return "default-function";
  if (typeof pdfParseModule?.PDFParse === "function") return "PDFParse-class";
  return "unavailable";
};

// Multer config
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ];
    const allowedExtensions = [".pdf", ".docx"];
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (allowedMimeTypes.includes(file.mimetype) || allowedExtensions.includes(ext)) cb(null, true);
    else cb(new Error("Only PDF and DOCX files are allowed"));
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

// Resume Analysis Schema
const resumeAnalysisSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  fileName: String,
  extractedText: String,
  atsScore: Number,
  missingSkills: [String],
  skillsFound: [String],
  education: [String],
  experience: [String],
  grammarCorrections: [String],
  suggestions: [String],
  strengths: [String],
  weaknesses: [String],
  matchingRoles: [{ role: String, matchPercentage: Number }],
  createdAt: { type: Date, default: Date.now }
});
const ResumeAnalysis = mongoose.model("ResumeAnalysis", resumeAnalysisSchema);

// Text extraction helpers
const extractPDF = async (buffer) => {
  try {
    if (typeof pdfParseModule === "function") {
      const data = await pdfParseModule(buffer);
      return data?.text || "";
    }

    if (typeof pdfParseModule?.default === "function") {
      const data = await pdfParseModule.default(buffer);
      return data?.text || "";
    }

    if (typeof pdfParseModule?.PDFParse === "function") {
      const parser = new pdfParseModule.PDFParse({ data: buffer });
      try {
        const data = await parser.getText();
        return data?.text || "";
      } finally {
        await parser.destroy();
      }
    }

    throw new Error("No compatible PDF parser was found.");
  } catch (error) {
    const message = error?.message || "Unknown PDF parser error";
    throw new Error(`PDF text extraction failed: ${message}. If this is a scanned/image-only PDF, convert it to a text-based PDF or DOCX and try again.`);
  }
};
const extractDOCX = async (buffer) => {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
};
const extractText = async (buffer, mimeType, fileName = "") => {
  const ext = path.extname(fileName).toLowerCase();
  if (mimeType === "application/pdf" || ext === ".pdf") return extractPDF(buffer);
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || ext === ".docx") return extractDOCX(buffer);
  throw new Error("Unsupported file type");
};

const normalizeResumeText = (text) => text
  .replace(/\r/g, "\n")
  .replace(/[ \t]+/g, " ")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const findMatchingTerms = (text, terms) => {
  const t = text.toLowerCase();
  return terms.filter((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9+#.])${escaped}([^a-z0-9+#.]|$)`, "i").test(t);
  });
};

const pickSectionLines = (text, sectionWords, maxLines = 5) => {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const sectionIndex = lines.findIndex((line) => sectionWords.some((word) => line.toLowerCase().includes(word)));
  if (sectionIndex === -1) return [];
  return lines.slice(sectionIndex, sectionIndex + maxLines);
};

// Local rule-based analysis (no API key)
const analyzeResume = (text) => {
  const t = text.toLowerCase();
  const allSkills = [
    "javascript","typescript","python","java","c++","c#","react","angular","vue","node.js","express",
    "mongodb","mysql","postgresql","sql","aws","azure","docker","kubernetes","git","github",
    "html","css","tailwind","bootstrap","php","django","flask","spring","rest api","graphql",
    "machine learning","deep learning","ai","tensorflow","pytorch","pandas","numpy","power bi",
    "excel","figma","ui/ux","linux","firebase","android","data analysis"
  ];
  const found = findMatchingTerms(text, allSkills);
  const missing = allSkills.filter(s => !t.includes(s)).slice(0, 8);
  const education = pickSectionLines(text, ["education", "degree", "university", "college", "bachelor", "master", "b.tech", "b.e"]);
  const experience = pickSectionLines(text, ["experience", "internship", "employment", "work history", "projects"], 8);
  const hasEducation = education.length > 0 || /(b\.?tech|bachelor|master|m\.?tech|degree|university|college|cgpa|gpa)/i.test(text);
  const hasExperience = experience.length > 0 || /(experience|intern|developer|engineer|worked|built|managed|led|created|developed)/i.test(text);
  const hasMetrics = /(\d+%|\d+\+|\d+\s*(users|clients|projects|months|years|members|students|requests|records|hours))/i.test(text);
  const hasContact = /(\S+@\S+\.\S+|\+?\d[\d\s-]{8,})/.test(text);

  const grammar = [];
  if (t.includes("teh")) grammar.push("'teh' â†’ 'the'");
  if (t.includes("recieve")) grammar.push("'recieve' â†’ 'receive'");
  if (t.includes("acheive")) grammar.push("'acheive' â†’ 'achieve'");
  if (grammar.length === 0) grammar.push("No obvious spelling errors.");

  const suggestions = [];
  if (text.length < 500) suggestions.push("Add more details about responsibilities.");
  if (!hasMetrics) suggestions.push("Add measurable achievements with numbers, percentages, users, project counts, or performance impact.");
  if (found.length < 5) suggestions.push("Include more role-specific technical skills in a dedicated Skills section.");
  if (!hasEducation) suggestions.push("Add a clear Education section with degree, institution, year, and CGPA/GPA if useful.");
  if (!hasExperience) suggestions.push("Add internship, project, or work experience with action verbs and outcomes.");
  if (!hasContact) suggestions.push("Add clear contact details such as email and phone number.");
  if (!t.includes("linkedin")) suggestions.push("Add LinkedIn profile link.");
  if (suggestions.length === 0) suggestions.push("Resume looks strong. Keep tailoring keywords for each job description.");

  const strengths = [];
  if (found.length > 2) strengths.push(`Technical skills found: ${found.slice(0,8).join(", ")}`);
  if (hasEducation) strengths.push("Education details are present.");
  if (hasExperience) strengths.push("Experience/projects section is present.");
  if (hasMetrics) strengths.push("Resume includes measurable achievements.");
  if (text.length > 1000) strengths.push("Resume has enough detail for ATS parsing.");
  if (t.includes("lead") || t.includes("managed")) strengths.push("Leadership experience shown.");
  if (strengths.length === 0) strengths.push("Clear structure.");

  const weaknesses = [];
  if (text.length < 800) weaknesses.push("Resume is short. Add stronger project, responsibility, and achievement details.");
  if (found.length < 3) weaknesses.push("Limited technical skills listed.");
  if (!hasEducation) weaknesses.push("No clear education section detected.");
  if (!hasExperience) weaknesses.push("No clear work/project experience section detected.");
  if (!hasMetrics) weaknesses.push("Few measurable results or impact statements detected.");
  if (weaknesses.length === 0) weaknesses.push("Could be tailored for specific roles.");

  let atsScore = 35;
  atsScore += Math.min(found.length * 4, 28);
  if (text.length > 800) atsScore += 10;
  if (text.length > 1500) atsScore += 7;
  if (hasEducation) atsScore += 8;
  if (hasExperience) atsScore += 8;
  if (hasMetrics) atsScore += 7;
  if (hasContact) atsScore += 5;
  atsScore = Math.min(atsScore, 100);

  const roles = [];
  if (found.some(s => ["react","angular","vue"].includes(s))) roles.push({ role: "Frontend Developer", matchPercentage: 75 });
  if (found.some(s => ["node.js","express"].includes(s))) roles.push({ role: "Backend Developer", matchPercentage: 70 });
  if (found.some(s => ["mongodb","mysql","postgresql","sql"].includes(s))) roles.push({ role: "Database / SQL Developer", matchPercentage: 68 });
  if (found.some(s => ["docker","kubernetes","aws","azure"].includes(s))) roles.push({ role: "DevOps / Cloud Engineer", matchPercentage: 80 });
  if (found.includes("python") && found.some(s => ["machine learning","deep learning","ai","tensorflow","pytorch","pandas","numpy"].includes(s))) roles.push({ role: "AI/ML Engineer", matchPercentage: 85 });
  if (found.some(s => ["figma","ui/ux"].includes(s))) roles.push({ role: "UI/UX Designer", matchPercentage: 72 });
  if (roles.length === 0) roles.push({ role: hasExperience ? "Software Developer" : "Junior Developer / Intern", matchPercentage: 60 });

  return {
    atsScore,
    missingSkills: missing,
    skillsFound: found,
    education,
    experience,
    grammarCorrections: grammar,
    suggestions,
    strengths,
    weaknesses,
    matchingRoles: roles.slice(0,4)
  };
};

// API endpoints
app.post("/api/resume/analyze", authMiddleware, (req, res) => {
  upload.single("resume")(req, res, async (uploadErr) => {
    try {
      if (uploadErr) {
        const status = uploadErr.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        return res.status(status).json({ success: false, error: uploadErr.message });
      }
      if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded" });

      const rawText = await extractText(req.file.buffer, req.file.mimetype, req.file.originalname);
      const cleaned = normalizeResumeText(rawText);
      if (!cleaned) {
        return res.status(400).json({
          success: false,
          error: "Could not extract text from this resume. Please upload a text-based PDF or DOCX file."
        });
      }

      const analysis = analyzeResume(cleaned);
      const analysisWithText = {
        ...analysis,
        fileName: req.file.originalname,
        extractedText: cleaned.substring(0, 5000)
      };
      const saved = new ResumeAnalysis({
        user: req.userId,
        fileName: req.file.originalname,
        extractedText: analysisWithText.extractedText,
        ...analysis
      });
      await saved.save();
      res.json({ success: true, analysis: analysisWithText, analysisId: saved._id });
    } catch (err) {
      console.error("Resume analyze error:", err);
      res.status(500).json({ success: false, error: err.message || "Resume analysis failed" });
    }
  });
});

app.get("/api/resume/history", authMiddleware, async (req, res) => {
  try {
    const history = await ResumeAnalysis.find({ user: req.userId }).sort("-createdAt");
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/resume/analysis/:id", authMiddleware, async (req, res) => {
  try {
    const analysis = await ResumeAnalysis.findOne({ _id: req.params.id, user: req.userId });
    if (!analysis) return res.status(404).json({ error: "Not found" });
    res.json(analysis);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/resume/improve", authMiddleware, (req, res) => {
  const { originalText, suggestions } = req.body;
  if (!originalText) return res.status(400).json({ error: "Missing text" });
  let improved = originalText;
  if (suggestions?.length) {
    improved = `[AI Improvement Placeholder]\n\nBased on suggestions: ${suggestions.join(", ")}\n\nOriginal:\n${originalText}\n\nConsider adding quantifiable achievements and relevant keywords.`;
  }
  res.json({ improvedText: improved });
});

app.post("/api/resume/report", authMiddleware, async (req, res) => {
  try {
    const { analysis } = req.body;
    if (!analysis) return res.status(400).json({ error: "Missing analysis" });
    const html = `
      <!DOCTYPE html>
      <html><head><meta charset="UTF-8"><style>body{font-family:Arial;padding:20px} .score{font-size:48px;color:#4F46E5}</style></head>
      <body>
        <h1>Resume Report</h1>
        <p><strong>File:</strong> ${analysis.fileName}</p>
        <p><strong>ATS Score:</strong> <span class="score">${analysis.atsScore}/100</span></p>
        <h2>Missing Skills</h2><ul>${analysis.missingSkills.map(s=>`<li>${s}</li>`).join("")}</ul>
        <h2>Suggestions</h2><ul>${analysis.suggestions.map(s=>`<li>${s}</li>`).join("")}</ul>
        <h2>Strengths</h2><ul>${analysis.strengths.map(s=>`<li>${s}</li>`).join("")}</ul>
        <h2>Weaknesses</h2><ul>${analysis.weaknesses.map(s=>`<li>${s}</li>`).join("")}</ul>
        <h2>Best Roles</h2><ul>${analysis.matchingRoles.map(r=>`<li>${r.role} â€“ ${r.matchPercentage}%</li>`).join("")}</ul>
      </body></html>`;
    res.json({ html });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ========== ROADMAP FEATURE ==========

// ========== AUTHENTICATION MIDDLEWARE ==========
const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Access denied. No token provided.' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: decoded.id }; // Adjust if your token uses a different field (e.g., userId)
    next();
  } catch (err) {
    res.status(403).json({ error: 'Invalid or expired token.' });
  }
};





// Roadmap Progress Model
const roadmapProgressSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  courseName: { type: String, required: true },
  completedSteps: [{ type: Number, default: [] }],
  progressPercentage: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now }
});
const RoadmapProgress = mongoose.model('RoadmapProgress', roadmapProgressSchema);

// Predefined roadmaps
const ROADMAPS = {
  "MERN Stack": {
    steps: [
      { title: "JavaScript Essentials", topics: ["Variables", "Functions", "ES6+", "DOM"] },
      { title: "React.js", topics: ["Components", "Props", "State", "Hooks", "Router"] },
      { title: "Node.js & Express", topics: ["REST APIs", "Middleware", "Routing"] },
      { title: "MongoDB", topics: ["CRUD", "Aggregation", "Indexes"] },
      { title: "Full Stack Project", topics: ["Authentication", "Deployment"] }
    ]
  },
  "Frontend Developer": {
    steps: [
      { title: "HTML & CSS", topics: ["Semantic HTML", "Flexbox", "Grid"] },
      { title: "JavaScript", topics: ["ES6", "Async/Await", "DOM"] },
      { title: "React", topics: ["Components", "Hooks", "State Management"] },
      { title: "Tailwind CSS", topics: ["Utility Classes", "Responsive"] },
      { title: "Portfolio Project", topics: ["Deployment", "Performance"] }
    ]
  },
  "Python": {
    steps: [
      { title: "Python Basics", topics: ["Syntax", "Data Types", "Loops"] },
      { title: "OOP in Python", topics: ["Classes", "Inheritance", "Polymorphism"] },
      { title: "Data Science Libraries", topics: ["NumPy", "Pandas", "Matplotlib"] },
      { title: "Flask/Django", topics: ["Web Development", "APIs"] },
      { title: "Capstone Project", topics: ["Machine Learning Model"] }
    ]
  },
  "AI Engineer": {
    steps: [
      { title: "Python & Math", topics: ["Linear Algebra", "Calculus", "NumPy"] },
      { title: "Machine Learning", topics: ["Regression", "Classification", "Scikit-learn"] },
      { title: "Deep Learning", topics: ["Neural Networks", "TensorFlow/PyTorch"] },
      { title: "NLP & Computer Vision", topics: ["Transformers", "CNNs"] },
      { title: "MLOps & Deployment", topics: ["Docker", "FastAPI", "Cloud"] }
    ]
  },
  "Cyber Security": {
    steps: [
      { title: "Networking Basics", topics: ["OSI Model", "TCP/IP", "Subnetting"] },
      { title: "Security Fundamentals", topics: ["CIA Triad", "Cryptography", "Authentication"] },
      { title: "Ethical Hacking", topics: ["Kali Linux", "Metasploit", "Nmap"] },
      { title: "Web Security", topics: ["OWASP Top 10", "SQL Injection", "XSS"] },
      { title: "Security Operations", topics: ["SIEM", "Incident Response", "Compliance"] }
    ]
  },
   "Embedded Systems": {
    steps: [
      { title: "C Programming & Microcontrollers", topics: ["C syntax", "Pointers", "Memory management", "8051/AVR basics"] },
      { title: "Digital Electronics & Interfacing", topics: ["GPIO", "Timers", "Interrupts", "ADC/DAC"] },
      { title: "Real-Time Operating Systems (RTOS)", topics: ["Tasks", "Semaphores", "Queues", "FreeRTOS"] },
      { title: "ARM Cortex & Embedded Linux", topics: ["ARM architecture", "Device drivers", "Yocto/Buildroot"] },
      { title: "IoT & Communication Protocols", topics: ["UART", "I2C", "SPI", "CAN", "MQTT"] }
    ]
  },
  "Machine Learning": {
    steps: [
      { title: "Python for Data Science", topics: ["NumPy", "Pandas", "Matplotlib"] },
      { title: "Mathematics for ML", topics: ["Linear Algebra", "Calculus", "Probability", "Statistics"] },
      { title: "Supervised Learning", topics: ["Regression", "Classification", "Decision Trees", "SVM"] },
      { title: "Unsupervised & Advanced ML", topics: ["Clustering", "PCA", "Ensemble Methods"] },
      { title: "Model Deployment & MLOps", topics: ["Flask/FastAPI", "Docker", "CI/CD for ML"] }
    ]
  },
  "UI/UX Design": {
    steps: [
      { title: "Design Fundamentals", topics: ["Color theory", "Typography", "Grid systems", "Gestalt principles"] },
      { title: "User Research & Wireframing", topics: ["Personas", "User journeys", "Low-fidelity wireframes"] },
      { title: "Prototyping with Figma", topics: ["Components", "Auto layout", "Interactive prototypes"] },
      { title: "Usability Testing & Iteration", topics: ["A/B testing", "Heatmaps", "Usability metrics"] },
      { title: "Design Systems & Handoff", topics: ["Design tokens", "Storybook", "Developer handoff"] }
    ]
  }

};

// Roadmap Routes (place after your existing auth middleware)
app.post('/api/roadmap/search', auth, async (req, res) => {
  const { query } = req.body;
  const normalized = query.trim();
  const roadmap = ROADMAPS[normalized];
  if (!roadmap) {
    return res.status(404).json({ error: 'Roadmap not found' });
  }
  let progress = await RoadmapProgress.findOne({ userId: req.user.id, courseName: normalized });
  if (!progress) {
    progress = new RoadmapProgress({ userId: req.user.id, courseName: normalized, completedSteps: [] });
    await progress.save();
  }
  res.json({
    courseName: normalized,
    steps: roadmap.steps,
    completedSteps: progress.completedSteps,
    progressPercentage: progress.progressPercentage,
  });
});

app.post('/api/roadmap/complete-step', auth, async (req, res) => {
  const { courseName, stepIndex } = req.body;
  const userId = req.user.id;
  let progress = await RoadmapProgress.findOne({ userId, courseName });
  if (!progress) {
    progress = new RoadmapProgress({ userId, courseName, completedSteps: [] });
  }
  if (!progress.completedSteps.includes(stepIndex)) {
    progress.completedSteps.push(stepIndex);
    const totalSteps = ROADMAPS[courseName]?.steps.length || 5;
    progress.progressPercentage = Math.round((progress.completedSteps.length / totalSteps) * 100);
    await progress.save();
  }
  res.json({ success: true, completedSteps: progress.completedSteps, progressPercentage: progress.progressPercentage });
});

app.get('/api/roadmap/progress/:courseName', auth, async (req, res) => {
  const { courseName } = req.params;
  const progress = await RoadmapProgress.findOne({ userId: req.user.id, courseName });
  res.json({
    completedSteps: progress?.completedSteps || [],
    progressPercentage: progress?.progressPercentage || 0,
  });
});
// ========== END ROADMAP FEATURE ==========

const courses = [

  {
    title: "MERN Stack",
    videos: 45,
    description: "Learn MongoDB, Express, React and Node",
    image:
      "https://img.icons8.com/color/480/mongodb.png",
    videoUrl: "https://www.youtube.com/watch?v=7CqJlxBYj-M"
  },

  {
    title: "Frontend Developer",
    videos: 30,
    description: "HTML CSS JavaScript React",
    image:
      "https://img.icons8.com/color/480/react-native.png",
    videoUrl: "https://www.youtube.com/watch?v=zJSY8tbf_ys"
  },

  {
    title: "Python",
    videos: 50,
    description: "Python Full Course",
    image:
      "https://img.icons8.com/color/480/python.png",
    videoUrl: "https://www.youtube.com/watch?v=_uQrJ0TkZlc"
  },

  {
    title: "Machine Learning",
    videos: 40,
    description: "AI and ML Course",
    image:
      "https://img.icons8.com/color/480/artificial-intelligence.png",
    videoUrl: "https://www.youtube.com/watch?v=GwIo3gDZCVQ"
  },

  {
    title: "Cyber Security",
    videos: 35,
    description: "Learn Ethical Hacking",
    image:
      "https://img.icons8.com/color/480/hacker.png",
    videoUrl: "https://www.youtube.com/watch?v=inWWhr5tnEA"
  },

  {
    title: "UI UX Design",
    videos: 20,
    description: "Figma UI UX Complete Course",
    image:
      "https://img.icons8.com/color/480/figma--v1.png",
    videoUrl: "https://www.youtube.com/watch?v=c9Wg6Cb_YlU"
  },

  {
    title: "AutoCAD",
    videos: 18,
    description: "Engineering Drawing Course",
    image:
      "https://img.icons8.com/color/480/autodesk.png",
    videoUrl: "https://www.youtube.com/watch?v=VtLXKU1PpRU"
  },

  {
    title: "Professional English",
    videos: 25,
    description: "Spoken English Training",
    image:
      "https://img.icons8.com/color/480/language.png",
    videoUrl: "https://www.youtube.com/watch?v=juKd26qkNAw"
  }

];

app.get("/courses", (req, res) => {

  res.json(courses);

});

// ==========================
// ðŸš€ SERVER START
// ==========================
const PORT = process.env.PORT || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});


