/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Long from "long";

import * as beam from "../src/apache_beam";
import * as assert from "assert";
import {
  BytesCoder,
  IterableCoder,
  KVCoder,
} from "../src/apache_beam/coders/standard_coders";
import * as combiners from "../src/apache_beam/transforms/combiners";
import { GeneralObjectCoder } from "../src/apache_beam/coders/js_coders";

import { DirectRunner } from "../src/apache_beam/runners/direct_runner";
import { loopbackRunner } from "../src/apache_beam/runners/runner";
import { Pipeline } from "../src/apache_beam/internal/pipeline";
import * as testing from "../src/apache_beam/testing/assert";
import * as windowings from "../src/apache_beam/transforms/windowings";
import * as pardo from "../src/apache_beam/transforms/pardo";
import { withName } from "../src/apache_beam/transforms";
import * as service from "../src/apache_beam/utils/service";

let subprocessCache;
before(async function () {
  this.timeout(30000);
  subprocessCache = service.SubprocessService.createCache();
  if (process.env.BEAM_SERVICE_OVERRIDES) {
    // Start it up here so we don't timeout any individual test.
    await loopbackRunner().run(function pipeline(root) {
      root.apply(beam.impulse());
    });
  }
});

after(() => subprocessCache.stopAll());

export function suite(runner: beam.Runner = new DirectRunner()) {
  describe("testing.assertDeepEqual", function () {
    // The tests below won't catch failures if this doesn't fail.
    it("fails on bad assert", async function () {
      // TODO: There's probably a more idiomatic way to test failures.
      var seenError = false;
      try {
        await runner.run((root) => {
          const pcolls = root
            .apply(beam.create([1, 2, 3]))
            .apply(testing.assertDeepEqual([1, 2]));
        });
      } catch (Error) {
        seenError = true;
      }
      assert.equal(true, seenError);
    });
  });

  describe("runs basic transforms", function () {
    it("runs a map", async function () {
      await runner.run((root) => {
        const pcolls = root
          .apply(beam.create([1, 2, 3]))
          .map((x) => x * x)
          .apply(testing.assertDeepEqual([1, 4, 9]));
      });
    });

    it("runs a flatmap", async function () {
      await runner.run((root) => {
        const pcolls = root
          .apply(beam.create(["a b", "c"]))
          .flatMap((s) => s.split(/ +/))
          .apply(testing.assertDeepEqual(["a", "b", "c"]));
      });
    });

    it("runs a Splitter", async function () {
      await runner.run((root) => {
        const pcolls = root
          .apply(beam.create([{ a: 1 }, { b: 10 }, { a: 2, b: 20 }]))
          .apply(beam.split(["a", "b"], { exclusive: false }));
        pcolls.a.apply(testing.assertDeepEqual([1, 2]));
        pcolls.b.apply(testing.assertDeepEqual([10, 20]));
      });
    });

    it("runs a map with context", async function () {
      await runner.run((root) => {
        root
          .apply(beam.create([1, 2, 3]))
          .map((a: number, b: number) => a + b, 100)
          .apply(testing.assertDeepEqual([101, 102, 103]));
      });
    });

    it("runs a map with counters", async function () {
      const result = await new DirectRunner().run((root) => {
        root
          .apply(beam.create([1, 2, 3]))
          .map(
            withName(
              "mapWithCounter",
              pardo.withContext(
                (x: number, context) => {
                  context.myCounter.increment(x);
                  context.myDist.update(x);
                  return x * x;
                },
                {
                  myCounter: pardo.counter("myCounter"),
                  myDist: pardo.distribution("myDist"),
                }
              )
            )
          )
          .apply(testing.assertDeepEqual([1, 4, 9]));
      });
      assert.deepEqual((await result.counters()).myCounter, 1 + 2 + 3);
      assert.deepEqual((await result.distributions()).myDist, {
        count: 3,
        sum: 6,
        min: 1,
        max: 3,
      });
    });

    it("runs a map with singleton side input", async function () {
      await runner.run((root) => {
        const input = root.apply(beam.create([1, 2, 1]));
        const sideInput = root.apply(
          beam.withName("createSide", beam.create([4]))
        );
        input
          .map((e, context) => e / context.side.lookup(), {
            side: pardo.singletonSideInput(sideInput),
          })
          .apply(testing.assertDeepEqual([0.25, 0.5, 0.25]));
      });
    });

    it("runs a map with a side input sharing input root", async function () {
      await runner.run((root) => {
        const input = root.apply(beam.create([1, 2, 1]));
        // TODO: Can this type be inferred?
        const sideInput: beam.PCollection<{ sum: number }> = input.apply(
          beam.groupGlobally().combining((e) => e, combiners.sum, "sum")
        );
        input
          .map((e, context) => e / context.side.lookup().sum, {
            side: pardo.singletonSideInput(sideInput),
          })
          .apply(testing.assertDeepEqual([0.25, 0.5, 0.25]));
      });
    });

    it("runs a map with window-sensitive context", async function () {
      await runner.run((root) => {
        root
          .apply(beam.create([1, 2, 3, 4, 5, 10, 11, 12]))
          .apply(beam.assignTimestamps((t) => Long.fromValue(t * 1000)))
          .apply(beam.windowInto(windowings.fixedWindows(10)))
          .apply(beam.groupBy((e: number) => ""))
          .map(
            withName(
              "MapWithContext",
              pardo.withContext(
                // This is the function to apply.
                (kv, context) => {
                  return {
                    key: kv.key,
                    value: kv.value,
                    window_start_ms: context.window.lookup().start.low,
                    a: context.other,
                  };
                },
                // This is the context to pass as the second argument.
                // At each element, window.get() will return the associated window.
                { window: pardo.windowParam(), other: "A" }
              )
            )
          )
          .apply(
            testing.assertDeepEqual([
              { key: "", value: [1, 2, 3, 4, 5], window_start_ms: 0, a: "A" },
              { key: "", value: [10, 11, 12], window_start_ms: 10000, a: "A" },
            ])
          );
      });
    });

    it("runs a WindowInto", async function () {
      await runner.run((root) => {
        root
          .apply(beam.create(["apple", "apricot", "banana"]))
          .apply(beam.windowInto(windowings.globalWindows()))
          .apply(beam.groupBy((e: string) => e[0]))
          .apply(
            testing.assertDeepEqual([
              { key: "a", value: ["apple", "apricot"] },
              { key: "b", value: ["banana"] },
            ])
          );
      });
    });

    it("runs a WindowInto IntervalWindow", async function () {
      await runner.run((root) => {
        root
          .apply(beam.create([1, 2, 3, 4, 5, 10, 11, 12]))
          .apply(beam.assignTimestamps((t) => Long.fromValue(t * 1000)))
          .apply(beam.windowInto(windowings.fixedWindows(10)))
          .apply(beam.groupBy((e: number) => ""))
          .apply(
            testing.assertDeepEqual([
              { key: "", value: [1, 2, 3, 4, 5] },
              { key: "", value: [10, 11, 12] },
            ])
          );
      });
    });
  });

  describe("applies basic transforms", function () {
    // TODO: test output with direct runner.
    it("runs a basic Impulse expansion", function () {
      var p = new Pipeline();
      var res = new beam.Root(p).apply(beam.impulse());

      assert.equal(res.type, "pcollection");
      assert.deepEqual(p.context.getPCollectionCoder(res), new BytesCoder());
    });
    it("runs a ParDo expansion", function () {
      var p = new Pipeline();
      var res = new beam.Root(p)
        .apply(beam.impulse())
        .map(function (v: any) {
          return v * 2;
        })
        .map(function (v: number) {
          return v * 4;
        });

      assert.deepEqual(
        p.context.getPCollectionCoder(res),
        new GeneralObjectCoder()
      );
      assert.equal(res.type, "pcollection");
    });
    // why doesn't map need types here?
    it("runs a GroupBy expansion", function () {
      var p = new Pipeline();
      var res = new beam.Root(p)
        .apply(beam.impulse())
        .map(function createElement(v) {
          return { name: "pablo", lastName: "wat" };
        })
        .apply(beam.groupBy("lastName"));

      assert.deepEqual(
        p.context.getPCollectionCoder(res),
        new KVCoder(
          new GeneralObjectCoder(),
          new IterableCoder(new GeneralObjectCoder())
        )
      );
    });
  });
}

describe("primitives module", function () {
  describe("direct runner", suite.bind(this));
  if (process.env.BEAM_SERVICE_OVERRIDES) {
    describe("portable runner @ulr", () => {
      suite.bind(this)(loopbackRunner());
    });
  }
});
