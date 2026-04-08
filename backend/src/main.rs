use actix_files::Files;
use actix_web::{App, HttpResponse, HttpServer, get, middleware};
use env_logger::Env;

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let port = 8080;
    env_logger::Builder::from_env(Env::default().default_filter_or("info")).init();

    println!("Serving on http://localhost:{}/", port);
    println!("Static files: ./static -> /");
    println!("Spatial cache: ./spatial_cache -> /spatial_cache");

    HttpServer::new(|| {
        App::new()
            // Serve static files from the ./static directory at /
            .wrap(middleware::Logger::new(
                r#"%a "%r" %s %b "%{Referer}i" "%{User-Agent}i" %T"#,
            ))
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
