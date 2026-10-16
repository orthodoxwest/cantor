//! Just enough of the ONNX format to read a model's initializers (its weights), so the model
//! file stays the one source of them.

use std::collections::HashMap;

/// An initializer's shape and its little-endian values, as the file stores them.
pub struct Tensor {
    pub dims: Vec<usize>,
    data_type: u64,
    raw: Vec<u8>,
}

/// ONNX's element types this reader takes.
const FLOAT: u64 = 1;
const INT32: u64 = 6;
const INT64: u64 = 7;
const DOUBLE: u64 = 11;

impl Tensor {
    fn values<const N: usize, T>(&self, want: u64, from: fn([u8; N]) -> T) -> Result<Vec<T>, String> {
        if self.data_type != want {
            return Err(format!("element type {} where {want} was expected", self.data_type));
        }
        let count: usize = self.dims.iter().product();
        if self.raw.len() != count * N {
            return Err(format!("{} bytes for {count} values", self.raw.len()));
        }
        Ok(self
            .raw
            .chunks_exact(N)
            .map(|c| from(c.try_into().expect("chunks are N bytes")))
            .collect())
    }

    pub fn f32s(&self) -> Result<Vec<f32>, String> {
        self.values(FLOAT, f32::from_le_bytes)
    }

    pub fn f64s(&self) -> Result<Vec<f64>, String> {
        self.values(DOUBLE, f64::from_le_bytes)
    }

    pub fn i32s(&self) -> Result<Vec<i32>, String> {
        self.values(INT32, i32::from_le_bytes)
    }

    pub fn i64s(&self) -> Result<Vec<i64>, String> {
        self.values(INT64, i64::from_le_bytes)
    }
}

/// A protobuf message's fields in order: field number and value.
fn fields(mut bytes: &[u8]) -> Result<Vec<(u64, Field<'_>)>, String> {
    let mut out = Vec::new();
    while !bytes.is_empty() {
        let key = varint(&mut bytes)?;
        let field = match key & 7 {
            0 => Field::Varint(varint(&mut bytes)?),
            1 => {
                take(&mut bytes, 8)?;
                Field::Fixed
            }
            2 => {
                let len = usize::try_from(varint(&mut bytes)?).map_err(|e| e.to_string())?;
                Field::Bytes(take(&mut bytes, len)?)
            }
            5 => {
                take(&mut bytes, 4)?;
                Field::Fixed
            }
            wire => return Err(format!("protobuf wire type {wire}")),
        };
        out.push((key >> 3, field));
    }
    Ok(out)
}

enum Field<'a> {
    Varint(u64),
    Fixed,
    Bytes(&'a [u8]),
}

fn take<'a>(bytes: &mut &'a [u8], len: usize) -> Result<&'a [u8], String> {
    if bytes.len() < len {
        return Err("protobuf field runs past its message".into());
    }
    let (head, rest) = bytes.split_at(len);
    *bytes = rest;
    Ok(head)
}

fn varint(bytes: &mut &[u8]) -> Result<u64, String> {
    let mut value = 0u64;
    for shift in (0..64).step_by(7) {
        let [b, rest @ ..] = *bytes else {
            return Err("protobuf varint runs past its message".into());
        };
        *bytes = rest;
        value |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err("protobuf varint longer than 64 bits".into())
}

// Field numbers in onnx.proto.
const MODEL_GRAPH: u64 = 7;
const GRAPH_INITIALIZER: u64 = 5;
const TENSOR_DIMS: u64 = 1;
const TENSOR_DATA_TYPE: u64 = 2;
const TENSOR_NAME: u64 = 8;
const TENSOR_RAW_DATA: u64 = 9;

/// The initializers of the model in `model`, by name. Only initializers stored as raw data
/// are read; others are skipped.
pub fn initializers(model: &[u8]) -> Result<HashMap<String, Tensor>, String> {
    let mut out = HashMap::new();
    for (number, field) in fields(model)? {
        let (MODEL_GRAPH, Field::Bytes(graph)) = (number, field) else {
            continue;
        };
        for (number, field) in fields(graph)? {
            let (GRAPH_INITIALIZER, Field::Bytes(tensor)) = (number, field) else {
                continue;
            };
            let (mut name, mut dims, mut data_type, mut raw) = (None, Vec::new(), 0, None);
            for (number, field) in fields(tensor)? {
                match (number, field) {
                    (TENSOR_DIMS, Field::Varint(d)) => dims.push(d as usize),
                    (TENSOR_DIMS, Field::Bytes(mut packed)) => {
                        while !packed.is_empty() {
                            dims.push(varint(&mut packed)? as usize);
                        }
                    }
                    (TENSOR_DATA_TYPE, Field::Varint(t)) => data_type = t,
                    (TENSOR_NAME, Field::Bytes(n)) => name = Some(String::from_utf8_lossy(n).into_owned()),
                    (TENSOR_RAW_DATA, Field::Bytes(r)) => raw = Some(r.to_vec()),
                    _ => {}
                }
            }
            if let (Some(name), Some(raw)) = (name, raw) {
                out.insert(name, Tensor { dims, data_type, raw });
            }
        }
    }
    Ok(out)
}
