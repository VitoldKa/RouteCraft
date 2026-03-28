use actix_files::Files;
use actix_web::{App, HttpResponse, HttpServer, get, middleware};

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let port = 8080;
    println!("Serving on http://localhost:{}/", port);

    HttpServer::new(|| {
        App::new()
            // Serve static files from the ./static directory at /
            .wrap(middleware::DefaultHeaders::new().add(("Cache-Control", "public, max-age=60")))
            .service(Files::new("/spatial_cache", "./spatial_cache"))
            .service(Files::new("/", "./static").index_file("index.html"))
    })
    .bind(("0.0.0.0", port))?
    .run()
    .await
}

#[get("/api/version")]
async fn version() -> HttpResponse {
    let v = std::env::var("APP_VERSION").unwrap_or_else(|_| "unknown".into());
    HttpResponse::Ok().content_type("text/plain").body(v)
}
