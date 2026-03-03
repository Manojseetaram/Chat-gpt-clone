use axum::{
    extract::Multipart,
    http::Method,
    response::Json,
    routing::post,
    Router,
};
use base64::{engine::general_purpose, Engine as _};
use dotenv::dotenv;
use reqwest::Client;
use serde::Serialize;
use std::env;
use tower_http::cors::{Any, CorsLayer};

#[derive(Serialize)]
struct LLMResponse {
    text: String,
    audio_b64: String,
}

#[tokio::main]
async fn main() {
    dotenv().ok();

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::POST, Method::OPTIONS])
        .allow_headers(Any);

    let app = Router::new()
        .route("/ask", post(handle_audio))
        .layer(cors);

    let port = env::var("PORT").unwrap_or_else(|_| "8000".to_string());
    let addr: std::net::SocketAddr = format!("0.0.0.0:{}", port).parse().unwrap();

    println!("Server running on http://0.0.0.0:{}", port);

    axum::Server::bind(&addr)
        .serve(app.into_make_service())
        .await
        .unwrap();
}

async fn handle_audio(mut multipart: Multipart) -> Json<LLMResponse> {
    let mut audio_bytes = Vec::new();
    let mut filename = String::from("audio.webm");
    let mut session_id = String::from("default_session");

    while let Some(field) = multipart.next_field().await.unwrap() {
        let field_name = field.name().unwrap_or("").to_string();

        if field_name == "session_id" {
            // Read session_id as text
            let bytes = field.bytes().await.unwrap();
            session_id = String::from_utf8_lossy(&bytes).trim().to_string();
            println!("Session ID: {}", session_id);
            continue;
        }

        // It's the audio field
        if let Some(fname) = field.file_name() {
            filename = fname.to_string();
        }
        let data = field.bytes().await.unwrap();
        audio_bytes.extend_from_slice(&data);
    }

    println!("Received audio: {} bytes, filename: {}", audio_bytes.len(), filename);

    if audio_bytes.len() < 1000 {
        return Json(LLMResponse { text: String::new(), audio_b64: String::new() });
    }

    let groq_key = env::var("GROQ_API_KEY").expect("GROQ_API_KEY not set");
    let client = Client::new();

    // ── 1. Groq Whisper STT ───────────────────────────────────────────────
    let mime = if filename.ends_with(".ogg") { "audio/ogg" }
               else if filename.ends_with(".mp4") { "audio/mp4" }
               else { "audio/webm" };

    let part = reqwest::multipart::Part::bytes(audio_bytes)
        .file_name(filename.clone())
        .mime_str(mime).unwrap();

    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", "whisper-large-v3-turbo")
        .text("language", "en")
        .text("response_format", "json");

    let whisper_json = client
        .post("https://api.groq.com/openai/v1/audio/transcriptions")
        .header("Authorization", format!("Bearer {}", groq_key))
        .multipart(form)
        .send().await.unwrap()
        .json::<serde_json::Value>().await.unwrap();

    let user_text = whisper_json["text"].as_str().unwrap_or("").trim().to_string();
    if user_text.is_empty() {
        println!("No speech detected");
        return Json(LLMResponse { text: String::new(), audio_b64: String::new() });
    }
    println!("User said: {}", user_text);

    // ── 2. Friend's Custom LLM ────────────────────────────────────────────
    let llm_backend_url = env::var("LLM_BACKEND_URL")
        .unwrap_or_else(|_| "https://ai-avatar-chatbot-3g3w.onrender.com/chat".to_string());

    let llm_resp = client
        .post(&llm_backend_url)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "question": user_text,
            "session_id": session_id
        }))
        .send().await;

    let llm_text = match llm_resp {
        Ok(resp) if resp.status().is_success() => {
            // Read raw body text first so we can debug exactly what comes back
            let raw = resp.text().await.unwrap_or_default();
            println!("LLM raw response: {}", raw);

            let json: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
            println!("LLM json keys: {:?}", json.as_object().map(|o| o.keys().collect::<Vec<_>>()));

            // Try every possible field name
            let text = json["Response"]
                .as_str()
                .or_else(|| json["response"].as_str())
                .or_else(|| json["text"].as_str())
                .or_else(|| json["answer"].as_str())
                .or_else(|| json["message"].as_str())
                .or_else(|| json["output"].as_str())
                .or_else(|| json["result"].as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            println!("LLM extracted text: '{}'", text);
            text
        }
        Ok(resp) => {
            println!("LLM backend error status: {}", resp.status());
            String::new()
        }
        Err(e) => {
            println!("LLM backend request failed: {}", e);
            String::new()
        }
    };

    if llm_text.is_empty() {
        return Json(LLMResponse { text: String::new(), audio_b64: String::new() });
    }

    // ── 3. ElevenLabs TTS (optional) ─────────────────────────────────────
    let audio_b64 = if let Ok(el_key) = env::var("ELEVENLABS_API_KEY") {
        let tts_resp = client
            .post("https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM")
            .header("xi-api-key", el_key)
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "text": llm_text,
                "model_id": "eleven_turbo_v2_5",
                "voice_settings": {
                    "stability": 0.5,
                    "similarity_boost": 0.85,
                    "style": 0.2,
                    "use_speaker_boost": true
                }
            }))
            .send().await;

        match tts_resp {
            Ok(resp) if resp.status().is_success() => {
                let bytes = resp.bytes().await.unwrap_or_default();
                println!("ElevenLabs TTS: {} bytes", bytes.len());
                general_purpose::STANDARD.encode(&bytes)
            }
            Ok(resp) => { println!("ElevenLabs error: {}", resp.status()); String::new() }
            Err(e)   => { println!("ElevenLabs failed: {}", e); String::new() }
        }
    } else {
        println!("No ELEVENLABS_API_KEY — browser TTS fallback");
        String::new()
    };

    Json(LLMResponse { text: llm_text, audio_b64 })
}