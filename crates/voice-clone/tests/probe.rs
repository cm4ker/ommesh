use ort::session::Session;

#[test]
#[ignore]
fn probe() {
    let dir = std::env::var("XTTS_DIR").unwrap();
    for name in ["conditioning_encoder.onnx", "speaker_encoder.onnx", "hifigan_vocoder.onnx", "gpt_model_int8.onnx"] {
        let t = std::time::Instant::now();
        let s = Session::builder().unwrap().commit_from_file(format!("{dir}/{name}")).unwrap();
        println!("== {name} loaded in {:?}", t.elapsed());
        for i in s.inputs().iter().take(4) { println!("  in  {} {:?}", i.name(), i.dtype()); }
        for o in s.outputs().iter().take(4) { println!("  out {} {:?}", o.name(), o.dtype()); }
        println!("  {} inputs, {} outputs", s.inputs().len(), s.outputs().len());
    }
}
