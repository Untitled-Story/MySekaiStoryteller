use std::fmt;
use std::io;

/// Unified error type returned by the headless pure-Rust video renderer pipeline.
#[derive(Debug)]
pub enum RendererError {
    InvalidConfig(String),
    Io(io::Error),
    Json {
        context: String,
        source: serde_json::Error,
    },
    UnsupportedModelFormat(String),
    UnsupportedLegacyModel(String),
    ModelLoad(String),
    MissingAsset(String),
    InvalidAssetPath(String),
    AudioDecode(String),
    AudioEncode(String),
    VideoEncode(String),
    Mux(String),
    Gpu(String),
    Render(String),
    FontLoad(String),
    ImageDecode(String),
    Live2d(String),
    Cancelled,
}

impl fmt::Display for RendererError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidConfig(msg) => write!(f, "Invalid export configuration: {msg}"),
            Self::Io(err) => write!(f, "I/O error: {err}"),
            Self::Json { context, source } => write!(f, "JSON parse error in {context}: {source}"),
            Self::UnsupportedModelFormat(msg) => write!(f, "{msg}"),
            Self::UnsupportedLegacyModel(msg) => write!(f, "{msg}"),
            Self::ModelLoad(msg) => write!(f, "Model loading error: {msg}"),
            Self::MissingAsset(msg) => write!(f, "Missing project asset: {msg}"),
            Self::InvalidAssetPath(msg) => write!(f, "Invalid asset path: {msg}"),
            Self::AudioDecode(msg) => write!(f, "Audio decode error: {msg}"),
            Self::AudioEncode(msg) => write!(f, "AAC encode error: {msg}"),
            Self::VideoEncode(msg) => write!(f, "H.264 encode error: {msg}"),
            Self::Mux(msg) => write!(f, "MP4 mux error: {msg}"),
            Self::Gpu(msg) => write!(f, "Headless GPU renderer error: {msg}"),
            Self::Render(msg) => write!(f, "Render error: {msg}"),
            Self::FontLoad(msg) => write!(f, "Font loading error: {msg}"),
            Self::ImageDecode(msg) => write!(f, "Image decode error: {msg}"),
            Self::Live2d(msg) => write!(f, "Live2D runtime error: {msg}"),
            Self::Cancelled => write!(f, "Video export cancelled"),
        }
    }
}

impl std::error::Error for RendererError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(err) => Some(err),
            Self::Json { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl From<io::Error> for RendererError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

impl From<RendererError> for String {
    fn from(err: RendererError) -> Self {
        err.to_string()
    }
}
