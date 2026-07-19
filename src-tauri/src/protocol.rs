use http::header::{
    ACCEPT_RANGES, ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS,
    ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_EXPOSE_HEADERS, CONTENT_LENGTH, CONTENT_TYPE,
    ORIGIN, VARY,
};
use percent_encoding::percent_decode_str;
use std::{fs, path::PathBuf};
use tauri::{
    http::{Method, Request, Response, StatusCode},
    Runtime, UriSchemeContext,
};

fn decode_request_path(request: &Request<Vec<u8>>) -> Option<PathBuf> {
    decode_uri_path(request.uri().host(), request.uri().path())
}

fn decode_uri_path(host: Option<&str>, raw_path: &str) -> Option<PathBuf> {
    if matches!(host, Some(host) if host != "load-file" && host != "localhost") {
        return None;
    }
    if raw_path.is_empty() || raw_path == "/" {
        return None;
    }

    let decoded = percent_decode_str(raw_path).decode_utf8().ok()?;
    let normalized = normalize_decoded_path(decoded.as_ref());

    if normalized.is_empty() {
        return None;
    }

    Some(PathBuf::from(normalized))
}

#[cfg(target_os = "windows")]
fn normalize_decoded_path(decoded_path: &str) -> String {
    decoded_path
        .trim_start_matches('/')
        .trim_start_matches('\\')
        .to_string()
}

#[cfg(not(target_os = "windows"))]
fn normalize_decoded_path(decoded_path: &str) -> String {
    if decoded_path.starts_with("//") {
        decoded_path[1..].to_string()
    } else {
        decoded_path.to_string()
    }
}

fn response_origin(request: &Request<Vec<u8>>) -> &str {
    request
        .headers()
        .get(ORIGIN)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("*")
}

fn build_response(request: &Request<Vec<u8>>) -> http::response::Builder {
    Response::builder()
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, response_origin(request))
        .header(ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
        .header(ACCESS_CONTROL_ALLOW_HEADERS, "*")
        .header(
            ACCESS_CONTROL_EXPOSE_HEADERS,
            "Content-Type, Content-Length, Accept-Ranges, Content-Range",
        )
        .header(VARY, "Origin")
}

fn build_file_response(
    request: &Request<Vec<u8>>,
    bytes: Vec<u8>,
    path: &PathBuf,
) -> Response<Vec<u8>> {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let content_length = bytes.len().to_string();
    let body = if request.method() == Method::HEAD {
        Vec::new()
    } else {
        bytes
    };

    build_response(request)
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, mime.as_ref())
        .header(CONTENT_LENGTH, content_length)
        .header(ACCEPT_RANGES, "bytes")
        .body(body)
        .unwrap()
}

fn build_error_response(
    request: &Request<Vec<u8>>,
    status: StatusCode,
    message: &str,
) -> Response<Vec<u8>> {
    let body = if request.method() == Method::HEAD {
        Vec::new()
    } else {
        message.as_bytes().to_vec()
    };

    build_response(request)
        .status(status)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(CONTENT_LENGTH, message.len().to_string())
        .body(body)
        .unwrap()
}

pub fn register_story_protocol<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol(
        "mss",
        |_ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder| {
            std::thread::spawn(move || {
                if request.method() == Method::OPTIONS {
                    responder.respond(build_error_response(&request, StatusCode::NO_CONTENT, ""));
                    return;
                }

                let Some(path) = decode_request_path(&request) else {
                    log::warn!(
                        target: "backend::protocol",
                        "asset.request rejected method={} reason=invalid_path",
                        request.method()
                    );
                    responder.respond(build_error_response(
                        &request,
                        StatusCode::BAD_REQUEST,
                        "Missing file path",
                    ));
                    return;
                };

                match fs::read(&path) {
                    Ok(bytes) => responder.respond(build_file_response(&request, bytes, &path)),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        log_protocol_read_failure(&request, &path, &error);
                        responder.respond(build_error_response(
                            &request,
                            StatusCode::NOT_FOUND,
                            &format!("File not found: {}", path.display()),
                        ));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                        log_protocol_read_failure(&request, &path, &error);
                        responder.respond(build_error_response(
                            &request,
                            StatusCode::FORBIDDEN,
                            &format!("Permission denied: {}", path.display()),
                        ));
                    }
                    Err(error) => {
                        log_protocol_read_failure(&request, &path, &error);
                        responder.respond(build_error_response(
                            &request,
                            StatusCode::INTERNAL_SERVER_ERROR,
                            &format!("Failed to read {}: {error}", path.display()),
                        ));
                    }
                }
            });
        },
    )
}

fn log_protocol_read_failure(request: &Request<Vec<u8>>, path: &PathBuf, error: &std::io::Error) {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown");
    log::warn!(
        target: "backend::protocol",
        "asset.request failed method={} extension={} error_kind={:?} error={}",
        request.method(),
        extension,
        error.kind(),
        error
    );
}
