"""Builds CREPE (full) as ONNX for `cantor eval --oracle`, into vendor/crepe/full.onnx.

The weights are torchcrepe 0.0.24's (MIT), fetched from PyPI and checked by hash, and read
without torch. The model takes frames of 1024 samples at 16 kHz, each already centred and
scaled to unit deviation, and gives 360 sigmoid activations, 20 cents apart from bin 0 at
1997.38 cents above 10 Hz. Needs numpy and onnx.
"""

import hashlib
import io
import json
import pickle
import sys
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

VERSION = "0.0.24"
WHEEL = f"torchcrepe-{VERSION}-py3-none-any.whl"
SHA256 = "ec054c23c9d45328f213f93a0131570a3f0e5903e9382792bed95f17a8c36d5a"
OUT = Path(__file__).resolve().parent.parent / "vendor" / "crepe"


def wheel() -> bytes:
    cached = OUT / WHEEL
    if cached.exists():
        data = cached.read_bytes()
    else:
        index = json.load(urllib.request.urlopen(f"https://pypi.org/pypi/torchcrepe/{VERSION}/json"))
        url = next(u["url"] for u in index["urls"] if u["filename"] == WHEEL)
        data = urllib.request.urlopen(url).read()
    if hashlib.sha256(data).hexdigest() != SHA256:
        sys.exit(f"{WHEEL}: hash mismatch")
    OUT.mkdir(parents=True, exist_ok=True)
    cached.write_bytes(data)
    return data


def weights(pth: bytes) -> dict:
    """The state dict of a torch zip checkpoint, as numpy arrays, without torch."""
    archive = zipfile.ZipFile(io.BytesIO(pth))
    root = archive.namelist()[0].split("/")[0]
    dtypes = {"FloatStorage": np.float32, "LongStorage": np.int64}

    class Storage:
        def __init__(self, kind, key):
            self.array = np.frombuffer(archive.read(f"{root}/data/{key}"), dtype=dtypes[kind])

    def rebuild(storage, offset, size, stride, *_):
        if not size:
            return storage.array[offset : offset + 1].reshape(())
        strides = [s * storage.array.itemsize for s in stride]
        return np.lib.stride_tricks.as_strided(storage.array[offset:], shape=size, strides=strides).copy()

    class StateDict(dict):
        """An OrderedDict that takes the `_metadata` torch sets on it."""

    class Unpickler(pickle.Unpickler):
        def find_class(self, module, name):
            if (module, name) == ("torch._utils", "_rebuild_tensor_v2"):
                return rebuild
            if module == "torch" and name in dtypes:
                return name
            if (module, name) == ("collections", "OrderedDict"):
                return StateDict
            raise pickle.UnpicklingError(f"unexpected {module}.{name}")

        def persistent_load(self, pid):
            _, kind, key, _, _ = pid
            return Storage(kind, key)

    return Unpickler(io.BytesIO(archive.read(f"{root}/data.pkl"))).load()


def model(w: dict) -> onnx.ModelProto:
    nodes, inits = [], []

    def const(name, array):
        inits.append(numpy_helper.from_array(np.ascontiguousarray(array), name))
        return name

    # One-dimensional throughout: torchcrepe's 2-D convolutions have width 1.
    nodes.append(helper.make_node("Reshape", ["frames", const("shape_in", np.array([-1, 1, 1024], np.int64))], ["x0"]))
    x = "x0"
    for i in range(1, 7):
        top, bottom = (254, 254) if i == 1 else (31, 32)
        stride = 4 if i == 1 else 1
        pads = const(f"pads{i}", np.array([0, 0, top, 0, 0, bottom], np.int64))
        nodes.append(helper.make_node("Pad", [x, pads], [f"p{i}"]))
        weight = w[f"conv{i}.weight"][..., 0]
        nodes.append(
            helper.make_node(
                "Conv",
                [f"p{i}", const(f"w{i}", weight), const(f"b{i}", w[f"conv{i}.bias"])],
                [f"c{i}"],
                strides=[stride],
            )
        )
        nodes.append(helper.make_node("Relu", [f"c{i}"], [f"r{i}"]))
        bn = [const(f"bn{i}_{k}", w[f"conv{i}_BN.{k}"]) for k in ("weight", "bias", "running_mean", "running_var")]
        nodes.append(helper.make_node("BatchNormalization", [f"r{i}", *bn], [f"n{i}"], epsilon=0.0010000000474974513))
        nodes.append(helper.make_node("MaxPool", [f"n{i}"], [f"m{i}"], kernel_shape=[2], strides=[2]))
        x = f"m{i}"
    nodes.append(helper.make_node("Transpose", [x], ["t"], perm=[0, 2, 1]))
    nodes.append(helper.make_node("Reshape", ["t", const("shape_out", np.array([-1, 2048], np.int64))], ["flat"]))
    nodes.append(
        helper.make_node(
            "Gemm", ["flat", const("cw", w["classifier.weight"]), const("cb", w["classifier.bias"])], ["logits"], transB=1
        )
    )
    nodes.append(helper.make_node("Sigmoid", ["logits"], ["activations"]))
    graph = helper.make_graph(
        nodes,
        "crepe-full",
        [helper.make_tensor_value_info("frames", TensorProto.FLOAT, ["n", 1024])],
        [helper.make_tensor_value_info("activations", TensorProto.FLOAT, ["n", 360])],
        inits,
    )
    m = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)], ir_version=8)
    onnx.checker.check_model(m)
    return m


def main() -> None:
    archive = zipfile.ZipFile(io.BytesIO(wheel()))
    w = weights(archive.read("torchcrepe/assets/full.pth"))
    onnx.save(model(w), OUT / "full.onnx")
    (OUT / "LICENSE").write_bytes(archive.read(f"torchcrepe-{VERSION}.dist-info/licenses/LICENSE"))
    print(OUT / "full.onnx")


if __name__ == "__main__":
    main()
