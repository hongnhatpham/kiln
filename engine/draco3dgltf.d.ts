declare module "draco3dgltf" {
  // Only the decoder is used; gltf-transform consumes the module object as-is.
  const draco3d: {
    createDecoderModule(options?: object): Promise<unknown>;
    createEncoderModule(options?: object): Promise<unknown>;
  };
  export default draco3d;
}
