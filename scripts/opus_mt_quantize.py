"""Merge and int8-quantize the OPUS-MT ONNX exports so Transformers.js can run them.

Run from .vendor-tmp/tfjs after `python -m scripts.convert --model_id Helsinki-NLP/opus-mt-xx-yy
--task text2text-generation-with-past` (see scripts/make_opus_mt.sh). Two fixes over convert.py's
own --quantize:
  * merge decoder + decoder_with_past with optimum directly: convert.py's merged decoder bakes
    the past length into the position embeddings and fails at runtime ("Starts must be a 1-D array");
  * pre-transpose the tied embedding so the output projection is an initializer and gets
    quantized too (otherwise a 117 MB fp32 copy stays in the decoder).
"""
import os
import sys

import onnx
from onnx import numpy_helper
from onnxruntime.quantization import QuantType, quantize_dynamic
from optimum.onnx import merge_decoders

W = "model.shared.weight_transposed"
for m in sys.argv[1:] or ["opus-mt-en-tl", "opus-mt-tl-en"]:
    d = f"models/Helsinki-NLP/{m}/"
    merged = merge_decoders(d + "decoder_model.onnx", d + "decoder_with_past_model.onnx", strict=False)
    g = merged.graph
    shared = [i for i in g.initializer if i.name.startswith("model.shared.weight")]
    assert len(shared) == 1, [i.name for i in shared]

    def strip(graph):
        for node in list(graph.node):
            if node.op_type == "Transpose" and list(node.input) == [shared[0].name]:
                assert list(node.output) == [W], node.output
                graph.node.remove(node)
            for a in node.attribute:
                if a.g.node:
                    strip(a.g)

    strip(g)
    g.initializer.append(numpy_helper.from_array(numpy_helper.to_array(shared[0]).T.copy(), W))
    onnx.save(merged, d + "merged_fix.onnx")
    os.makedirs(d + "onnx", exist_ok=True)
    for src, dst in [(d + "encoder_model.onnx", "encoder_model"), (d + "merged_fix.onnx", "decoder_model_merged")]:
        quantize_dynamic(src, f"{d}onnx/{dst}_quantized.onnx", weight_type=QuantType.QUInt8,
                         op_types_to_quantize=["MatMul", "Gather"], extra_options={"EnableSubgraph": True})
    for f in os.listdir(d + "onnx"):
        if f not in ("encoder_model_quantized.onnx", "decoder_model_merged_quantized.onnx"):
            os.remove(d + "onnx/" + f)
    print(f"   {m}: encoder + merged decoder quantized")
