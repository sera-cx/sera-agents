import { describe,it,expect,vi,beforeEach } from "vitest";
vi.mock("@coinbase/cdp-sdk/auth",()=>({generateJwt:vi.fn(async()=>"short.jwt")}));
import { facilitatorVerify,facilitatorSettle } from "../facilitator.js";
const cfg={url:"https://api.cdp.coinbase.com/platform/v2/x402",apiKeyId:"id",apiKeySecret:"secret"};
const req={scheme:"exact" as const,network:"eip155:84532" as const,maxAmountRequired:"1000000",resource:"https://service/x402/swap",description:"x",mimeType:"application/json",payTo:"0x1",maxTimeoutSeconds:60,asset:"0x2",extra:{}};
describe("CDP v2 facilitator",()=>{beforeEach(()=>globalThis.fetch=vi.fn() as any);
 it("binds a JWT to /verify and uses v2 body",async()=>{(fetch as any).mockResolvedValue({ok:true,status:200,text:async()=>'{"isValid":true}'});await facilitatorVerify(cfg,"sig",req);const [url,init]=(fetch as any).mock.calls[0];expect(url).toMatch(/\/verify$/);expect((init.headers as any).authorization).toBe("Bearer short.jwt");expect(JSON.parse(init.body)).toMatchObject({x402Version:2,paymentPayload:"sig"});});
 it("retains a rejected settle reason",async()=>{(fetch as any).mockResolvedValue({ok:false,status:422,text:async()=>'{"errorReason":"rejected"}'});const r=await facilitatorSettle(cfg,"sig",req);expect(r).toMatchObject({success:false,errorReason:"rejected"});});
 it("retains transaction and network",async()=>{(fetch as any).mockResolvedValue({ok:true,status:200,text:async()=>'{"success":true,"transaction":"0xabc","network":"eip155:84532"}'});expect(await facilitatorSettle(cfg,"sig",req)).toMatchObject({success:true,transaction:"0xabc",network:"eip155:84532"});});});
